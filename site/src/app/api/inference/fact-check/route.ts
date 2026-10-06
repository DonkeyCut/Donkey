import { NextResponse } from "next/server";

import { creditMicrosToString, zeroCreditMicros } from "@/lib/credits/amounts";
import {
  creditErrorResponse,
  inferenceUsageRoutes,
  recordFailedInferenceUsage,
  recordInferenceUsage,
  requireInferenceCredits,
} from "@/lib/credits/inference";
import { geminiSearchProviderId } from "@/lib/credits/provider-pricing";
import { getGlobalSetting } from "@/lib/config/effective";
import {
  FACT_ANSWER_SCHEMA,
  FACT_CHECK_INSTRUCTIONS,
  factCheckPrompt,
  factCheckRequestSchema,
  shapeFactCheck,
  type FactCheckOutcome,
  type FactSource,
} from "@/lib/inference/factCheck";
import { geminiModelRoles } from "@/lib/inference/gemini-models";
import { isJsonObject, toJsonValue } from "@/lib/inference/json";
import { InferenceProviderError, type JsonObject, type JsonValue } from "@/lib/inference/providers";
import {
  inferenceErrorCode,
  inferenceProviderErrorResponse,
  requireInferenceClientId,
  validationErrorResponse,
} from "@/lib/inference/responses";
import { createProviderRegistry } from "@/lib/inference/router";
import { responseCreateRequestSchema } from "@/lib/inference/schemas";
import {
  INFERENCE_RATE_LIMIT,
  shouldBypassDonkeyInferenceCredits,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";

// Check a video's factual claims against the web. Each claim is its own call
// to the fact-check model with Google Search on, so the sources a verdict
// reports are exactly the pages that claim's search returned. The page, the
// worker and the ChatGPT card post here with the user's session; the route
// pins the model and bills each call's tokens and searches.

export const maxDuration = 120;

const requestKind = "fact_check";
const route = inferenceUsageRoutes.factCheck;

// Grounding hands back Google's redirect links. The page they lead to is what
// the user reads and what a capture opens, so each is followed once here.
const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const REDIRECT_TIMEOUT_MS = 4000;

async function resolveSource(source: FactSource): Promise<FactSource> {
  let host: string;
  try {
    host = new URL(source.url).hostname;
  } catch {
    return source;
  }
  if (host !== GROUNDING_REDIRECT_HOST) return source;
  const res = await fetch(source.url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(REDIRECT_TIMEOUT_MS),
  }).catch(() => null);
  const location = res?.headers.get("location");
  // A link that does not resolve is still the link the search returned.
  if (!location || !/^https?:\/\//i.test(location)) return source;
  return { url: location, title: source.title };
}

function sourcesOf(body: JsonValue): FactSource[] {
  const raw = isJsonObject(body) && Array.isArray(body.sources) ? body.sources : [];
  return raw.flatMap((s) =>
    isJsonObject(s) && typeof s.url === "string" && typeof s.title === "string" ? [{ url: s.url, title: s.title }] : [],
  );
}

function searchSuggestionsOf(body: JsonValue): string | undefined {
  return isJsonObject(body) && typeof body.search_suggestions === "string" ? body.search_suggestions : undefined;
}

function queryCount(body: JsonValue): number {
  return isJsonObject(body) && Array.isArray(body.search_queries) ? body.search_queries.length : 0;
}

/** The provider's usage with the search folded in: the pages a search fed the
 * model bill as input, and each query bills as one generation. */
function billedUsage(usage: JsonValue | undefined, queries: number): JsonObject {
  const meta: JsonObject = usage !== undefined && isJsonObject(usage) ? usage : {};
  const num = (v: JsonValue | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    ...meta,
    promptTokenCount: num(meta.promptTokenCount) + num(meta.toolUsePromptTokenCount),
    generationCount: queries,
  };
}

/** Run `work` over `items`, at most `limit` at a time, keeping their order. */
async function inPool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(lanes);
  return out;
}

export const POST = withDonkeyAuth(async (request) => {
  const client = requireInferenceClientId(request.donkey.clientId);
  if (!client.ok) {
    return client.response;
  }

  const parsed = factCheckRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return validationErrorResponse(parsed.error);
  }
  const settings = await getGlobalSetting("factCheck");
  const { claims, context } = parsed.data;
  if (claims.length > settings.maxClaims) {
    return NextResponse.json(
      { error: "too_many_claims", message: `Check at most ${settings.maxClaims} claims at a time.` },
      { status: 400 },
    );
  }

  const model = geminiModelRoles.factCheck;
  const bypassCredits = shouldBypassDonkeyInferenceCredits(request.donkey);
  if (!bypassCredits) {
    // Every claim runs at least one search, so the balance has to cover that
    // many before any of them starts.
    const credits = await requireInferenceCredits({
      model,
      provider: geminiSearchProviderId,
      route,
      userId: request.donkey.userId,
      enforceModelPrice: true,
      generationCount: claims.length,
    });
    if (!credits.ok) {
      return credits.response;
    }
  }

  const registry = createProviderRegistry();
  const errors: unknown[] = [];
  // Each call charges on its own; the response reports their total and the
  // balance the last one left.
  const tally: { charged: bigint; remaining: bigint | null } = { charged: zeroCreditMicros, remaining: null };
  const results = await inPool(claims, settings.concurrency, async (claim): Promise<FactCheckOutcome> => {
    try {
      const call = responseCreateRequestSchema.parse({
        donkeyProvider: "gemini",
        model,
        instructions: FACT_CHECK_INSTRUCTIONS,
        input: factCheckPrompt(claim, context),
        tools: [{ type: "web_search" }],
        text: { format: { type: "json_schema", name: "fact_check", schema: FACT_ANSWER_SCHEMA } },
      });
      const provider = registry.responsesProvider(call);
      const result = await provider.createResponse?.(call);
      if (!result) {
        throw new InferenceProviderError("Fact checking is unavailable.", {
          statusCode: 503,
          code: "responses_unavailable",
        });
      }
      const body = toJsonValue(result.body);
      if (!bypassCredits) {
        const recorded = await recordInferenceUsage({
          clientId: client.clientId,
          conversationId: request.donkey.conversationId,
          model: result.model,
          provider: geminiSearchProviderId,
          requestKind,
          route,
          status: "succeeded",
          usage: billedUsage(result.usage, queryCount(body)),
          userId: request.donkey.userId,
        });
        tally.charged += recorded.creditCostMicros;
        tally.remaining = recorded.remainingBalanceMicros;
      }
      const outputText = isJsonObject(body) && typeof body.output_text === "string" ? body.output_text : "";
      const sources = await Promise.all(sourcesOf(body).map(resolveSource));
      return shapeFactCheck(claim, outputText, sources, {
        minSources: settings.minSources,
        maxSources: settings.maxSourcesPerClaim,
        searchSuggestions: searchSuggestionsOf(body),
      });
    } catch (error) {
      errors.push(error);
      if (!bypassCredits && !request.signal.aborted) {
        await recordFailedInferenceUsage({
          clientId: client.clientId,
          conversationId: request.donkey.conversationId,
          errorCode: inferenceErrorCode(error),
          model,
          provider: geminiSearchProviderId,
          requestKind,
          route,
          userId: request.donkey.userId,
        }).catch(() => {});
      }
      return { claim, error: error instanceof Error ? error.message : "The check failed." };
    }
  });

  if (request.signal.aborted) {
    return new NextResponse(null, { status: 499 });
  }
  // Every claim failed: the reason is the request's, and answers as one.
  if (errors.length === claims.length) {
    const first = errors[0];
    const creditResponse = creditErrorResponse(first);
    if (creditResponse) {
      return creditResponse;
    }
    if (first instanceof InferenceProviderError) {
      return inferenceProviderErrorResponse(first);
    }
    throw first;
  }

  return NextResponse.json(
    { model, results },
    {
      headers: {
        "X-Donkey-Inference-Model": model,
        ...(bypassCredits ? { "X-Donkey-Dev-Auth-Bypass": "true" } : {}),
        ...(tally.remaining !== null
          ? {
              "X-Donkey-Credits-Charged": creditMicrosToString(tally.charged),
              "X-Donkey-Credits-Remaining": creditMicrosToString(tally.remaining),
            }
          : {}),
      },
    },
  );
}, { allowRunner: true, rateLimit: INFERENCE_RATE_LIMIT });
