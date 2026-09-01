import { NextResponse } from "next/server";

import { creditMicrosToString } from "@/lib/credits/amounts";

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
import { toJsonObject } from "@/lib/inference/json";
import {
  inferenceErrorCode,
  inferenceProviderErrorResponse,
  requireInferenceClientId,
  validationErrorResponse,
} from "@/lib/inference/responses";
import { InferenceProviderError } from "@/lib/inference/providers";
import { responseCreateRequestSchema } from "@/lib/inference/schemas";
import {
  INFERENCE_RATE_LIMIT,
  shouldBypassDonkeyInferenceCredits,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";

export const POST = withDonkeyAuth(async (request) => {
  const client = requireInferenceClientId(request.donkey.clientId);
  if (!client.ok) {
    return client.response;
  }

  const parsed = responseCreateRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return validationErrorResponse(parsed.error);
  }

  const requestedModel =
    typeof parsed.data.body.model === "string" && parsed.data.body.model.trim()
      ? parsed.data.body.model.trim()
      : "unknown";
  const bypassCredits = shouldBypassDonkeyInferenceCredits(request.donkey);
  if (!bypassCredits) {
    const credits = await requireInferenceCredits({
      model: requestedModel,
      provider: parsed.data.donkeyProvider,
      route: inferenceUsageRoutes.responses,
      userId: request.donkey.userId,
    });
    if (!credits.ok) {
      return credits.response;
    }
  }

  let failedUsageProvider = parsed.data.donkeyProvider ?? "default";

  try {
    // Attached pictures and sound ride storage, not the request body — they
    // become inline content parts here, on the server-to-server leg.
    const data = {
      ...parsed.data,
      body: toJsonObject(
        await resolveInferenceBlobs(parsed.data.body, request.donkey.userId),
      ),
    };
    const registry = createProviderRegistry();
    const provider = registry.responsesProvider(data);
    failedUsageProvider = provider.id;

    if (data.stream) {
      const streamed = await provider.createResponseStream?.(data);
      if (!streamed) {
        if (!bypassCredits) {
          await recordFailedInferenceUsage({
            clientId: client.clientId,
            conversationId: request.donkey.conversationId,
            errorCode: "streaming_unavailable",
            model: requestedModel,
            provider: failedUsageProvider,
            requestKind: "responses",
            route: inferenceUsageRoutes.responses,
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

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (data: unknown) =>
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
            );
          try {
            for await (const event of streamed.events) {
              if (event.type === "output_text_delta") {
                send({ type: "response.output_text.delta", delta: event.delta });
                continue;
              }
              // Bill from the terminal usage before the terminal event goes
              // out: the invocation lives only as long as the stream, so the
              // usage row must land before the client can stop reading.
              // The balance after the charge rides the terminal frame — the
              // headers went out before the charge existed — so the page's
              // credits readout moves the moment the reply lands.
              let creditsRemaining: string | undefined;
              if (!bypassCredits) {
                const recorded = await recordInferenceUsage({
                  clientId: client.clientId,
                  conversationId: request.donkey.conversationId,
                  model: streamed.model,
                  provider: streamed.provider,
                  requestKind: "responses",
                  route: inferenceUsageRoutes.responses,
                  status: "succeeded",
                  usage: event.usage,
                  userId: request.donkey.userId,
                });
                creditsRemaining = creditMicrosToString(recorded.remainingBalanceMicros);
              }
              send({ type: "response.completed", response: event.body, creditsRemaining });
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch (error) {
            if (!bypassCredits) {
              await recordFailedInferenceUsage({
                clientId: client.clientId,
                conversationId: request.donkey.conversationId,
                errorCode: inferenceErrorCode(error),
                model: streamed.model,
                provider: streamed.provider,
                requestKind: "responses",
                route: inferenceUsageRoutes.responses,
                userId: request.donkey.userId,
              }).catch(() => {});
            }
            // A mid-stream failure surfaces as a terminal SSE error event so
            // the client stops cleanly instead of hanging on a truncated stream.
            const message =
              error instanceof Error ? error.message : "stream failed";
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({ message })}\n\n`,
              ),
            );
          } finally {
            controller.close();
          }
        },
      });

      const bypassHeaders: Record<string, string> = bypassCredits
        ? { "X-Donkey-Dev-Auth-Bypass": "true" }
        : {};
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Donkey-Inference-Provider": streamed.provider,
          "X-Donkey-Inference-Model": streamed.model,
          ...bypassHeaders,
        },
      });
    }

    const result = await provider.createResponse?.(data);
    if (!result) {
      if (!bypassCredits) {
        await recordFailedInferenceUsage({
          clientId: client.clientId,
          conversationId: request.donkey.conversationId,
          errorCode: "responses_unavailable",
          model: requestedModel,
          provider: failedUsageProvider,
          requestKind: "responses",
          route: inferenceUsageRoutes.responses,
          userId: request.donkey.userId,
        });
      }

      return NextResponse.json(
        {
          error: "Responses unavailable",
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
        requestKind: "responses",
        route: inferenceUsageRoutes.responses,
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
        requestKind: "responses",
        route: inferenceUsageRoutes.responses,
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
