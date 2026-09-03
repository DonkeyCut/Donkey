import { NextResponse } from "next/server";

import {
  creditErrorResponse,
  creditUsageHeaders,
  inferenceUsageRoutes,
  recordFailedInferenceUsage,
  recordInferenceUsage,
  requireInferenceCredits,
} from "@/lib/credits/inference";
import {
  assetGenerationResponse,
  generationIDForRequest,
} from "@/lib/inference/assets";
import { createProviderRegistry } from "@/lib/inference/router";
import {
  inferenceErrorCode,
  inferenceProviderErrorResponse,
  requireInferenceClientId,
  validationErrorResponse,
} from "@/lib/inference/responses";
import { assetGenerationRequestSchema } from "@/lib/inference/schemas";
import {
  INFERENCE_RATE_LIMIT,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";
import { resolveInferenceBlobs } from "@/lib/inference/blobs";
import { InferenceProviderError, type JsonObject } from "@/lib/inference/providers";
import { toJsonObject, toJsonValue } from "@/lib/inference/json";

// Music generation (Gemini/Lyria) polls its render to completion in-request, so
// the handler can stay open longer than the platform default. Image, video, and
// speech return well inside this; it is a ceiling, not a delay.
export const maxDuration = 120;

export const POST = withDonkeyAuth(async (request) => {
  const client = requireInferenceClientId(request.donkey.clientId);
  if (!client.ok) {
    return client.response;
  }

  const parsed = assetGenerationRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return validationErrorResponse(parsed.error);
  }

  // Select the provider, settle the model it will bill, and count the units the request will
  // charge, all before the preflight, so credit limits and pricing are scoped to what actually
  // runs. Callers routinely omit the model and let the adapter pick one (music picks by requested
  // length), so asking the provider is the only way the preflight sees the id that gets charged.
  // Reference pictures and seed frames ride storage, not the request body — they become inline
  // data on the server-to-server leg. That resolution reads whole objects out of storage, so it
  // waits for the balance to clear; a provider whose count is read from the resolved media (the
  // matte segmenter's frame chunks) pulls it ahead of the preflight through the resolver it is
  // handed. The promise is memoized, so the request resolves at most once either way.
  let resolving: Promise<typeof parsed.data> | undefined;
  const resolveRequest = () => (resolving ??= resolveRequestOnce());
  const resolveRequestOnce = async () => {
    const inputs: JsonObject | undefined = parsed.data.inputs
      ? toJsonObject(
          await resolveInferenceBlobs(
            toJsonValue(parsed.data.inputs),
            request.donkey.userId,
          ),
        )
      : undefined;
    return inputs ? { ...parsed.data, inputs } : parsed.data;
  };
  let provider;
  let model;
  let generationRequest;
  let generationCount: number | undefined;
  try {
    provider = createProviderRegistry().assetProvider(parsed.data);
    model = provider.assetModelFor?.(parsed.data) ?? parsed.data.model;
    generationRequest = parsed.data;
    if (provider.assetGenerationCountFor) {
      generationCount = await provider.assetGenerationCountFor(parsed.data, resolveRequest);
    }
  } catch (error) {
    // A rejected request still leaves its diagnostic trail, same as a
    // failure after the preflight.
    await recordFailedInferenceUsage({
      clientId: client.clientId,
      conversationId: request.donkey.conversationId,
      errorCode: inferenceErrorCode(error),
      metadata: {
        assetKind: parsed.data.kind,
      },
      model: model ?? parsed.data.model ?? "default",
      provider: provider?.id ?? parsed.data.provider ?? "unresolved",
      requestKind: "asset_generation",
      route: inferenceUsageRoutes.assets,
      userId: request.donkey.userId,
    });
    if (error instanceof InferenceProviderError) {
      return inferenceProviderErrorResponse(error);
    }
    throw error;
  }

  const credits = await requireInferenceCredits({
    model,
    provider: provider.id,
    route: inferenceUsageRoutes.assets,
    userId: request.donkey.userId,
    // The billed model is known here, so the preflight holds the generation to it: an unpriced
    // model never runs and bills upstream, and a priced one never starts on a balance that
    // can't cover the full unit count.
    enforceModelPrice: true,
    generationCount,
  });
  if (!credits.ok) {
    return credits.response;
  }

  const failedUsageProvider = provider.id;

  try {
    generationRequest = await resolveRequest();
    const generationId = generationIDForRequest(parsed.data);
    const generation = {
      id: generationId,
      kind: parsed.data.kind,
    };
    const result = await provider.generateAsset?.({
      generationId,
      request: generationRequest,
      generationCount,
    });

    if (!result) {
      await recordFailedInferenceUsage({
        clientId: client.clientId,
        conversationId: request.donkey.conversationId,
        errorCode: "asset_generation_unavailable",
        metadata: {
          assetKind: parsed.data.kind,
        },
        model: model ?? "default",
        provider: failedUsageProvider,
        requestKind: "asset_generation",
        route: inferenceUsageRoutes.assets,
        userId: request.donkey.userId,
      });

      return NextResponse.json(
        {
          error: "Asset generation unavailable",
        },
        { status: 503 },
      );
    }

    // A provider can settle a generation as failed synchronously (a safety
    // filter at submit) — that did no billable work, but the failure goes on
    // the books so a dead render leaves a diagnostic trail.
    if (result.status === "failed") {
      await recordFailedInferenceUsage({
        clientId: client.clientId,
        conversationId: request.donkey.conversationId,
        errorCode: "provider_error",
        metadata: {
          assetKind: parsed.data.kind,
          generationId,
          ...(result.error !== undefined && result.error !== null
            ? { providerError: result.error }
            : {}),
        },
        model: result.model,
        provider: result.provider,
        requestKind: "asset_generation",
        route: inferenceUsageRoutes.assets,
        userId: request.donkey.userId,
      });
      return NextResponse.json(assetGenerationResponse({ generation, result }), {
        status: 201,
      });
    }

    // The submit is the billable moment, for sync and async results alike: a
    // sync completion carries its real usage, and an async render bills the
    // flat clip price (the adapter stamps the generation-count unit) — so one
    // submission charges exactly once by construction, and the polls that
    // follow (assets/refresh) are free.
    const recordedUsage = await recordInferenceUsage({
      clientId: client.clientId,
      conversationId: request.donkey.conversationId,
      metadata: {
        assetKind: parsed.data.kind,
        generationId,
      },
      model: result.model,
      provider: result.provider,
      requestKind: "asset_generation",
      route: inferenceUsageRoutes.assets,
      status: "succeeded",
      usage: result.usage,
      userId: request.donkey.userId,
    });

    return NextResponse.json(assetGenerationResponse({ generation, result }), {
      headers: creditUsageHeaders(recordedUsage),
      status: 201,
    });
  } catch (error) {
    await recordFailedInferenceUsage({
      clientId: client.clientId,
      conversationId: request.donkey.conversationId,
      errorCode: inferenceErrorCode(error),
      metadata: {
        assetKind: parsed.data.kind,
      },
      model: model ?? "default",
      provider: failedUsageProvider,
      requestKind: "asset_generation",
      route: inferenceUsageRoutes.assets,
      userId: request.donkey.userId,
    });
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
