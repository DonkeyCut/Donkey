import { NextResponse } from "next/server";

import {
  inferenceUsageRoutes,
  recordFailedInferenceUsage,
} from "@/lib/credits/inference";
import { refreshedAssetGenerationResponse } from "@/lib/inference/assets";
import { createProviderRegistry } from "@/lib/inference/router";
import {
  inferenceErrorCode,
  inferenceProviderErrorResponse,
  requireInferenceClientId,
  validationErrorResponse,
} from "@/lib/inference/responses";
import { storedGenerationForProviderSchema } from "@/lib/inference/schemas";
import {
  INFERENCE_RATE_LIMIT,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";
import { InferenceProviderError } from "@/lib/inference/providers";

export const POST = withDonkeyAuth(async (request) => {
  const client = requireInferenceClientId(request.donkey.clientId);
  if (!client.ok) {
    return client.response;
  }

  const parsed = storedGenerationForProviderSchema.safeParse(await request.json());
  if (!parsed.success) {
    return validationErrorResponse(parsed.error);
  }

  // No credit gate here: the clip was billed flat at submit, so a poll does no
  // new billable work — and gating it would strand a render the user already
  // paid for behind a balance drained by sibling charges.
  try {
    const registry = createProviderRegistry();
    const result = await registry.refresh(parsed.data);

    // An operation that finished as FAILED did no billable work — no charge, but the failure
    // goes on the books so a dead render leaves a diagnostic trail instead of vanishing.
    if (result.status === "failed") {
      await recordFailedInferenceUsage({
        clientId: client.clientId,
        conversationId: request.donkey.conversationId,
        errorCode: "provider_error",
        metadata: {
          assetKind: parsed.data.kind,
          generationId: parsed.data.id,
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
    }

    return NextResponse.json(
      refreshedAssetGenerationResponse({
        generation: parsed.data,
        result,
      }),
    );
  } catch (error) {
    await recordFailedInferenceUsage({
      clientId: client.clientId,
      conversationId: request.donkey.conversationId,
      errorCode: inferenceErrorCode(error),
      metadata: {
        assetKind: parsed.data.kind,
      },
      model: parsed.data.model,
      provider: parsed.data.provider,
      requestKind: "asset_refresh",
      route: inferenceUsageRoutes.assetsRefresh,
      userId: request.donkey.userId,
    });
    if (error instanceof InferenceProviderError) {
      return inferenceProviderErrorResponse(error);
    }

    throw error;
  }
}, { allowRunner: true, rateLimit: INFERENCE_RATE_LIMIT });
