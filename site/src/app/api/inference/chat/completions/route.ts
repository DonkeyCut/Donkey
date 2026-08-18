import { NextResponse } from "next/server";

import {
  creditErrorResponse,
  creditUsageHeaders,
  inferenceUsageRoutes,
  recordFailedInferenceUsage,
  recordInferenceUsage,
  requireInferenceCredits,
} from "@/lib/credits/inference";
import { createProviderRegistry } from "@/lib/inference/router";
import { resolveInferenceBlobs } from "@/lib/inference/blobs";
import { toJsonValue } from "@/lib/inference/json";
import {
  inferenceErrorCode,
  inferenceProviderErrorResponse,
  requireInferenceClientId,
  validationErrorResponse,
} from "@/lib/inference/responses";
import { chatCompletionRequestSchema } from "@/lib/inference/schemas";
import {
  shouldBypassDonkeyInferenceCredits,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";
import { InferenceProviderError } from "@/lib/inference/providers";

export const POST = withDonkeyAuth(async (request) => {
  const client = requireInferenceClientId(request.donkey.clientId);
  if (!client.ok) {
    return client.response;
  }

  const parsed = chatCompletionRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return validationErrorResponse(parsed.error);
  }

  if (
    parsed.data.stream &&
    parsed.data.modalities?.some((modality) => modality !== "text")
  ) {
    return NextResponse.json(
      {
        error: "Unsupported stream",
        message: "Streaming is supported for text completions only.",
      },
      { status: 400 },
    );
  }

  const requestedModel =
    parsed.data.model?.trim() || parsed.data.models?.[0]?.trim() || "unknown";
  const bypassCredits = shouldBypassDonkeyInferenceCredits(request.donkey);
  if (!bypassCredits) {
    const credits = await requireInferenceCredits({
      model: requestedModel,
      route: inferenceUsageRoutes.chatCompletions,
      userId: request.donkey.userId,
    });
    if (!credits.ok) {
      return credits.response;
    }
  }

  let failedUsageProvider = "default";

  try {
    // Attached pictures and sound ride storage, not the request body — they
    // become inline message parts here, on the server-to-server leg.
    const data = {
      ...parsed.data,
      messages: (await resolveInferenceBlobs(
        toJsonValue(parsed.data.messages),
        request.donkey.userId,
      )) as typeof parsed.data.messages,
    };
    const registry = createProviderRegistry();
    const provider = registry.textProvider(data.stream);
    failedUsageProvider = provider.id;

    if (data.stream) {
      const result = await provider.streamCompletion?.(data);
      if (!result) {
        if (!bypassCredits) {
          await recordFailedInferenceUsage({
            clientId: client.clientId,
            conversationId: request.donkey.conversationId,
            errorCode: "streaming_unavailable",
            model: requestedModel,
            provider: failedUsageProvider,
            requestKind: "chat_completions",
            route: inferenceUsageRoutes.chatCompletions,
            userId: request.donkey.userId,
          });
        }

        return NextResponse.json(
          {
            error: "Streaming unavailable",
          },
          { status: 503 },
        );
      }

      let streamUsageHeaders: Record<string, string> = {};
      if (bypassCredits) {
        streamUsageHeaders["X-Donkey-Dev-Auth-Bypass"] = "true";
      } else {
        const recordedUsage = await recordInferenceUsage({
          clientId: client.clientId,
          conversationId: request.donkey.conversationId,
          model: result.model,
          provider: result.provider,
          requestKind: "chat_completions",
          route: inferenceUsageRoutes.chatCompletions,
          status: "succeeded",
          userId: request.donkey.userId,
        });
        streamUsageHeaders = creditUsageHeaders(recordedUsage);
      }

      return new Response(result.response.body, {
        status: result.response.status,
        headers: {
          "Content-Type":
            result.response.headers.get("content-type") ?? "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Donkey-Inference-Provider": result.provider,
          "X-Donkey-Inference-Model": result.model,
          ...streamUsageHeaders,
        },
      });
    }

    const result = await provider.completeText?.(data);
    if (!result) {
      if (!bypassCredits) {
        await recordFailedInferenceUsage({
          clientId: client.clientId,
          conversationId: request.donkey.conversationId,
          errorCode: "completion_unavailable",
          model: requestedModel,
          provider: failedUsageProvider,
          requestKind: "chat_completions",
          route: inferenceUsageRoutes.chatCompletions,
          userId: request.donkey.userId,
        });
      }

      return NextResponse.json(
        {
          error: "Completion unavailable",
        },
        { status: 503 },
      );
    }

    let usageHeaders: Record<string, string> = {};
    if (bypassCredits) {
      usageHeaders["X-Donkey-Dev-Auth-Bypass"] = "true";
    } else {
      const recordedUsage = await recordInferenceUsage({
        clientId: client.clientId,
        conversationId: request.donkey.conversationId,
        model: result.model,
        provider: result.provider,
        requestKind: "chat_completions",
        route: inferenceUsageRoutes.chatCompletions,
        status: "succeeded",
        usage: result.usage,
        userId: request.donkey.userId,
      });
      usageHeaders = creditUsageHeaders(recordedUsage);
    }

    return NextResponse.json(result.body, {
      headers: {
        "X-Donkey-Inference-Provider": result.provider,
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
        model: requestedModel,
        provider: failedUsageProvider,
        requestKind: "chat_completions",
        route: inferenceUsageRoutes.chatCompletions,
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
});
