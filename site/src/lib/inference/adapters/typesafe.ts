import { APIConnectionError, APIError, TypeSafeClient } from "@typesafe-ai/sdk";

import type { AdapterEnvironment } from "@/lib/inference/adapters/gemini-client";
import type { Entry, JudgeQuestion, JudgeResult } from "@/lib/inference/judge";
import { InferenceProviderError } from "@/lib/inference/providers";
import { typesafeModels, typesafeProviderId } from "@/lib/inference/typesafe-models";

// The one seam to TypeSafe's System One API. Every judgment — the chat turn's
// route, queue triage, stock ranking, refusal classes — goes through
// `askJudge` here, on the server, with the account's key. The model is pinned
// from the registry; the page never names it.

// A judgment gates a turn that is already running, so a stall is answered
// fast: one attempt of 8 s, one retry.
const requestTimeoutMs = 8_000;
const maxRetries = 1;

export interface TypesafeJudge {
  readonly id: typeof typesafeProviderId;
  readonly model: string;
  readonly configured: boolean;
  askJudge<Q extends Record<string, JudgeQuestion>>(
    request: { state: Entry; questions: Q },
    signal?: AbortSignal,
  ): Promise<JudgeResult<Q>>;
}

export function createTypesafeJudge(
  environment: AdapterEnvironment = process.env,
  fetchImpl?: typeof fetch,
): TypesafeJudge {
  const apiKey = environment.TYPESAFE_API_KEY?.trim();
  const model = typesafeModels.jev;
  const client = apiKey
    ? new TypeSafeClient({
        apiKey,
        defaultModel: model,
        timeout: requestTimeoutMs,
        retry: { maxRetries },
        ...(fetchImpl ? { fetch: fetchImpl as never } : {}),
      })
    : null;

  async function askJudge<Q extends Record<string, JudgeQuestion>>(
    request: { state: Entry; questions: Q },
    signal?: AbortSignal,
  ): Promise<JudgeResult<Q>> {
    if (!client) {
      throw new InferenceProviderError("TypeSafe is not configured (TYPESAFE_API_KEY).", {
        statusCode: 503,
        code: "missing_provider_credentials",
      });
    }
    try {
      const result = await client.systemOne(
        { state: request.state as never, questions: request.questions as never, model },
        { signal },
      );
      return {
        model: result.model,
        answers: result.answers as unknown as JudgeResult<Q>["answers"],
        usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
      };
    } catch (error) {
      throw toProviderError(error);
    }
  }

  return { id: typesafeProviderId, model, configured: client !== null, askJudge };
}

function toProviderError(error: unknown): InferenceProviderError {
  if (error instanceof InferenceProviderError) return error;
  if (error instanceof APIError) {
    const status = error.status === 429 ? 429 : error.status >= 500 ? 502 : error.status === 401 ? 503 : 400;
    return new InferenceProviderError(`TypeSafe request failed (${error.status}): ${error.message}`, {
      statusCode: status,
      code:
        error.status === 401
          ? "missing_provider_credentials"
          : error.status === 429
            ? "rate_limited"
            : error.status === 422
              ? "invalid_request"
              : "provider_error",
      details: typeof error.body === "object" ? (error.body as never) : null,
    });
  }
  if (error instanceof APIConnectionError) {
    return new InferenceProviderError(`TypeSafe unreachable: ${error.message}`, {
      statusCode: 504,
      code: "provider_timeout",
    });
  }
  return new InferenceProviderError(error instanceof Error ? error.message : String(error), {
    statusCode: 502,
    code: "provider_error",
  });
}

let shared: TypesafeJudge | null = null;

/** The process-wide judge, built once from the environment. */
export function typesafeJudge(): TypesafeJudge {
  return (shared ??= createTypesafeJudge());
}
