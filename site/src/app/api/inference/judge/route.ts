import { NextResponse } from "next/server";

import {
  creditErrorResponse,
  creditUsageHeaders,
  inferenceUsageRoutes,
  recordFailedInferenceUsage,
  recordInferenceUsage,
  requireInferenceCredits,
} from "@/lib/credits/inference";
import { typesafeJudge } from "@/lib/inference/adapters/typesafe";
import { judgeRequestSchema, type JudgeQuestion } from "@/lib/inference/judge";
import { toJsonValue } from "@/lib/inference/json";
import { InferenceProviderError } from "@/lib/inference/providers";
import {
  inferenceErrorCode,
  inferenceProviderErrorResponse,
  requireInferenceClientId,
  validationErrorResponse,
} from "@/lib/inference/responses";
import {
  INFERENCE_RATE_LIMIT,
  shouldBypassDonkeyInferenceCredits,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";

// A judgment: typed questions over one state, answered as probabilities by
// TypeSafe's System One model. The page, the worker, and the eval post here
// with the user's session; the route bills the tokens and pins the model.

const requestKind = "judge";

export const POST = withDonkeyAuth(async (request) => {
  const client = requireInferenceClientId(request.donkey.clientId);
  if (!client.ok) {
    return client.response;
  }

  const parsed = judgeRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return validationErrorResponse(parsed.error);
  }

  const judge = typesafeJudge();
  const bypassCredits = shouldBypassDonkeyInferenceCredits(request.donkey);
  if (!bypassCredits) {
    const credits = await requireInferenceCredits({
      model: judge.model,
      provider: judge.id,
      route: inferenceUsageRoutes.judge,
      userId: request.donkey.userId,
      enforceModelPrice: true,
    });
    if (!credits.ok) {
      return credits.response;
    }
  }

  try {
    // Validated above: a score's criteria has at least two levels.
    const result = await judge.askJudge(
      { state: parsed.data.state, questions: parsed.data.questions as Record<string, JudgeQuestion> },
      request.signal,
    );

    let usageHeaders: Record<string, string> = {};
    if (bypassCredits) {
      usageHeaders["X-Donkey-Dev-Auth-Bypass"] = "true";
    } else {
      const recordedUsage = await recordInferenceUsage({
        clientId: client.clientId,
        conversationId: request.donkey.conversationId,
        model: result.model,
        provider: judge.id,
        requestKind,
        route: inferenceUsageRoutes.judge,
        status: "succeeded",
        usage: toJsonValue(result.usage),
        userId: request.donkey.userId,
      });
      usageHeaders = creditUsageHeaders(recordedUsage);
    }

    return NextResponse.json(result, {
      headers: {
        "X-Donkey-Inference-Provider": judge.id,
        "X-Donkey-Inference-Model": result.model,
        ...usageHeaders,
      },
    });
  } catch (error) {
    if (!bypassCredits) {
      await recordFailedInferenceUsage({
        clientId: client.clientId,
        conversationId: request.donkey.conversationId,
        errorCode: inferenceErrorCode(error),
        model: judge.model,
        provider: judge.id,
        requestKind,
        route: inferenceUsageRoutes.judge,
        userId: request.donkey.userId,
      });
    }
    const creditResponse = creditErrorResponse(error);
    if (creditResponse) {
      return creditResponse;
    }
    if (error instanceof InferenceProviderError) {
      return inferenceProviderErrorResponse(error);
    }
    throw error;
  }
}, { allowRunner: true, rateLimit: INFERENCE_RATE_LIMIT });
