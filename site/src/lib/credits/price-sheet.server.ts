import { creditMicrosToString, zeroCreditMicros } from "@/lib/credits/amounts";
import { inferenceUsageRoutes, usageCostMicros } from "@/lib/credits/inference";
import {
  autoVideoLength,
  musicLengths,
  type CreditPriceSheet,
  type MusicLength,
} from "@/lib/credits/price-sheet";
import type { NormalizedUsage } from "@/lib/credits/provider-pricing";
import { geminiOmniDurationSeconds, geminiOmniResolutions } from "@/lib/inference/gemini-models";
import type { AssetGenerationRequest, InferenceProvider } from "@/lib/inference/providers";
import { createProviderRegistry } from "@/lib/inference/router";

// Prices each option the editor offers the way the asset route bills it: the
// adapter names the billed model and unit count for the request, and the
// charge's own rate lookup prices that usage, database overrides included.

/** Picks the provider that serves a request, as the asset route does. */
export type AssetProviderLookup = (request: AssetGenerationRequest) => InferenceProvider;

const SPEECH_MINUTE_MILLIS = BigInt(60_000);

const EMPTY_USAGE: NormalizedUsage = {
  billableOutputTokens: zeroCreditMicros,
  cachedInputTokens: zeroCreditMicros,
  characterCost: zeroCreditMicros,
  durationMillis: zeroCreditMicros,
  generationCount: zeroCreditMicros,
  inputAudioTokens: zeroCreditMicros,
  inputTokens: zeroCreditMicros,
  outputAudioTokens: zeroCreditMicros,
  outputTokens: zeroCreditMicros,
  totalTokens: zeroCreditMicros,
};

/** The sheet as the asset route bills it now. */
export async function loadCreditPriceSheet(
  providerFor: AssetProviderLookup = registryLookup(),
): Promise<CreditPriceSheet> {
  const price = (request: AssetGenerationRequest, usage?: Partial<NormalizedUsage>) =>
    requestPrice(providerFor, request, usage);

  // Every size at every length, plus "auto" for a render that names none.
  const { min, max } = geminiOmniDurationSeconds;
  const lengths = [...Array.from({ length: max - min + 1 }, (_, i) => min + i), null];
  const video = Object.fromEntries(
    await Promise.all(
      geminiOmniResolutions.map(async (resolution) => {
        const byLength = await Promise.all(
          lengths.map(async (seconds) => {
            const parameters = seconds === null ? { resolution } : { resolution, durationSeconds: seconds };
            return [seconds === null ? autoVideoLength : String(seconds), await price(assetRequest("video", parameters))] as const;
          }),
        );
        return [resolution, Object.fromEntries(byLength)] as const;
      }),
    ),
  );

  const music = Object.fromEntries(
    await Promise.all(
      musicLengths.map(async (length) => [length, await price(assetRequest("music", { variant: length }))] as const),
    ),
  ) as Record<MusicLength, string>;

  // Speech bills by the audio it returns, so the sheet prices a minute of it.
  const speechMinute = await price(assetRequest("speech"), {
    generationCount: zeroCreditMicros,
    durationMillis: SPEECH_MINUTE_MILLIS,
  });

  return { video, image: await price(assetRequest("image")), music, speechMinute };
}

function registryLookup(): AssetProviderLookup {
  const registry = createProviderRegistry();
  return (request) => registry.assetProvider(request);
}

function assetRequest(kind: string, parameters: Record<string, unknown> = {}): AssetGenerationRequest {
  return { kind, prompt: "", parameters } as AssetGenerationRequest;
}

// One request priced the way the asset route charges it.
async function requestPrice(
  providerFor: AssetProviderLookup,
  request: AssetGenerationRequest,
  usage: Partial<NormalizedUsage> = {},
): Promise<string> {
  const provider = providerFor(request);
  const model = provider.assetModelFor?.(request) ?? request.model;
  if (!model) {
    throw new Error(`No billed model for a ${request.kind} request.`);
  }

  const count = provider.assetGenerationCountFor
    ? await provider.assetGenerationCountFor(request, async () => request)
    : 1;
  const micros = await usageCostMicros(inferenceUsageRoutes.assets, provider.id, model, {
    ...EMPTY_USAGE,
    generationCount: BigInt(count),
    ...usage,
  });
  return creditMicrosToString(micros);
}
