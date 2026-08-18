import { NextResponse } from "next/server";
import { z } from "zod";

import {
  browserUseDefaultMaxCostUsd,
  browserUseDefaultModel,
  browserUseProvider,
  getBrowserUse,
} from "@/lib/browser/client";
import {
  creditUsageHeaders,
  inferenceUsageRoutes,
  recordFailedInferenceUsage,
  recordInferenceUsage,
  requireInferenceCredits,
} from "@/lib/credits/inference";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";
import {
  requireInferenceClientId,
  validationErrorResponse,
} from "@/lib/inference/responses";

// The run executes server-side to completion (the SDK polls Browser Use here, not
// the app), so the function must be allowed to run long. maxCostUsd bounds the
// task so it finishes well within this.
export const maxDuration = 300;

const runSchema = z.object({
  task: z.string().min(1),
  startUrl: z.string().url().optional(),
  structuredOutputSchema: z.record(z.string(), z.unknown()).optional(),
});

// Run an agentic browser task and return its result. The backend runs it to
// completion and charges credits here (by step count), so charging never depends
// on the client polling.
export const POST = withDonkeyAuth(async (request) => {
  const client = requireInferenceClientId(request.donkey.clientId);
  if (!client.ok) return client.response;

  const parsed = runSchema.safeParse(await request.json());
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const credits = await requireInferenceCredits({
    userId: request.donkey.userId,
    route: inferenceUsageRoutes.browserRun,
    provider: browserUseProvider,
    model: browserUseDefaultModel,
  });
  if (!credits.ok) return credits.response;

  // v3 has no separate start-url field; fold it into the task prompt.
  const task = parsed.data.startUrl
    ? `Start at ${parsed.data.startUrl}. ${parsed.data.task}`
    : parsed.data.task;

  let session;
  try {
    session = await getBrowserUse().run(task, {
      model: browserUseDefaultModel,
      maxCostUsd: browserUseDefaultMaxCostUsd,
      timeout: (maxDuration - 20) * 1000,
      ...(parsed.data.structuredOutputSchema
        ? { outputSchema: parsed.data.structuredOutputSchema }
        : {}),
    });
  } catch (error) {
    // The run may have consumed Browser Use steps before throwing (SDK timeout/transport error).
    // Record a failed usage event for audit (a failed status is never charged) and return a clean
    // error instead of an unhandled 500 that leaves no trace of the run.
    await recordFailedInferenceUsage({
      userId: request.donkey.userId,
      clientId: client.clientId,
      conversationId: request.donkey.conversationId,
      route: inferenceUsageRoutes.browserRun,
      requestKind: "browser_automation",
      provider: browserUseProvider,
      model: browserUseDefaultModel,
      errorCode: "browser_run_failed",
      metadata: {
        message: error instanceof Error ? error.message : "Unknown error",
      },
    });
    return NextResponse.json(
      {
        error: "browser_run_failed",
        message: "The browser automation run did not complete.",
      },
      { status: 502 },
    );
  }

  const stepCount = session.stepCount ?? 0;
  // Browser Use bills steps even on failure, so charge regardless of success.
  const recorded = await recordInferenceUsage({
    userId: request.donkey.userId,
    clientId: client.clientId,
    conversationId: request.donkey.conversationId,
    route: inferenceUsageRoutes.browserRun,
    requestKind: "browser_automation",
    provider: browserUseProvider,
    model: browserUseDefaultModel,
    status: "succeeded",
    usage: { generationCount: stepCount },
    metadata: { isTaskSuccessful: session.isTaskSuccessful ?? null },
  });

  const output: unknown = session.output ?? null;
  const text = typeof output === "string" ? output : null;
  let structured: string | null = null;
  if (output !== null && typeof output === "object") {
    try {
      structured = JSON.stringify(output);
    } catch {
      // Unserializable output (e.g. a BigInt or circular reference) must not throw here — credits
      // were already charged above, so drop the structured payload rather than 500 after billing.
      structured = null;
    }
  }

  return NextResponse.json(
    {
      status: session.status,
      done: true,
      isTaskSuccessful: session.isTaskSuccessful ?? null,
      text,
      structured,
      recordingUrl: session.recordingUrls?.[0] ?? null,
      liveUrl: session.liveUrl ?? null,
      stepCount,
      lastStepSummary: session.lastStepSummary ?? null,
    },
    { headers: creditUsageHeaders(recorded) },
  );
});
