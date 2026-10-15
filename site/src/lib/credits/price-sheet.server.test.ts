import { describe, expect, test } from "bun:test";

import { creditMicrosToString } from "@/lib/credits/amounts";
import { providerCreditPricing, providerPricingCostMicros, type NormalizedUsage } from "@/lib/credits/provider-pricing";
import { createGeminiImageAssetProvider } from "@/lib/inference/adapters/gemini-image";
import { createGeminiMusicAssetProvider } from "@/lib/inference/adapters/gemini-music";
import { createGeminiOmniVideoAssetProvider } from "@/lib/inference/adapters/gemini-omni-video";
import { createGeminiSpeechAssetProvider } from "@/lib/inference/adapters/gemini-speech";
import { geminiOmniDurationSeconds, geminiOmniResolutions } from "@/lib/inference/gemini-models";
import type { AssetGenerationRequest, InferenceProvider } from "@/lib/inference/providers";
import { stubModule } from "@/lib/testing/stubModule";

// The Generate buttons read the sheet the asset route bills by: the adapter
// names the billed model and unit count, and the charge prices that usage,
// with a database rate overriding the code price.

type RateRow = { route: string | null; provider: string | null; model: string | null; baseCostMicros: bigint };
let rows: RateRow[] = [];

const ZERO = BigInt(0);
const prisma = {
  inferenceCreditRate: {
    findMany: async () =>
      rows.map((row, index) => ({
        ...row,
        id: `rate-${index}`,
        version: 1,
        inputTokenCostMicros: ZERO,
        outputTokenCostMicros: ZERO,
        totalTokenCostMicros: ZERO,
        characterCostMicros: ZERO,
        fallbackCostMicros: ZERO,
      })),
  },
};

await stubModule<typeof import("@/lib/prisma")>("@/lib/prisma", import.meta.url, { prisma: prisma as never });
const { loadCreditPriceSheet } = await import("./price-sheet.server");

const ENV = {
  GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
    project_id: "p",
    client_email: "svc@example.invalid",
    private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  }),
};
const NO_CLIENT = () => ({}) as never;
const PROVIDERS: Record<string, InferenceProvider> = {
  video: createGeminiOmniVideoAssetProvider(ENV, NO_CLIENT),
  image: createGeminiImageAssetProvider(ENV, NO_CLIENT),
  music: createGeminiMusicAssetProvider(ENV, NO_CLIENT),
  speech: createGeminiSpeechAssetProvider(ENV, NO_CLIENT),
};
const providerFor = (request: AssetGenerationRequest) => PROVIDERS[request.kind];

const EMPTY_USAGE: NormalizedUsage = {
  billableOutputTokens: ZERO,
  cachedInputTokens: ZERO,
  characterCost: ZERO,
  durationMillis: ZERO,
  generationCount: ZERO,
  inputAudioTokens: ZERO,
  inputTokens: ZERO,
  outputAudioTokens: ZERO,
  outputTokens: ZERO,
  totalTokens: ZERO,
};

const request = (kind: string, parameters: Record<string, unknown> = {}) =>
  ({ kind, prompt: "p", parameters }) as AssetGenerationRequest;

// What the route charges for one request at the code price.
async function charged(request: AssetGenerationRequest): Promise<string> {
  const provider = providerFor(request);
  const model = provider.assetModelFor!(request)!;
  const count = provider.assetGenerationCountFor
    ? await provider.assetGenerationCountFor(request, async () => request)
    : 1;
  const micros = providerPricingCostMicros(providerCreditPricing(provider.id, model), {
    ...EMPTY_USAGE,
    generationCount: BigInt(count),
  });
  return creditMicrosToString(micros);
}

describe("the price sheet the buttons read", () => {
  test("video matches the charge at every size and length", async () => {
    rows = [];
    const sheet = await loadCreditPriceSheet(providerFor);
    const { min, max } = geminiOmniDurationSeconds;
    for (const resolution of geminiOmniResolutions) {
      for (let seconds = min; seconds <= max; seconds++) {
        expect(sheet.video[resolution][String(seconds)]).toBe(
          await charged(request("video", { resolution, durationSeconds: seconds })),
        );
      }
      expect(sheet.video[resolution].auto).toBe(await charged(request("video", { resolution })));
    }
  });

  test("an image and each music length match the charge", async () => {
    rows = [];
    const sheet = await loadCreditPriceSheet(providerFor);
    expect(sheet.image).toBe(await charged(request("image")));
    expect(sheet.music.clip).toBe(await charged(request("music", { variant: "clip" })));
    expect(sheet.music.song).toBe(await charged(request("music", { variant: "song" })));
  });

  test("a minute of speech bills at the speech model's rate", async () => {
    rows = [];
    const sheet = await loadCreditPriceSheet(providerFor);
    const speech = request("speech");
    const model = PROVIDERS.speech.assetModelFor!(speech)!;
    const minute = providerPricingCostMicros(providerCreditPricing(PROVIDERS.speech.id, model), {
      ...EMPTY_USAGE,
      durationMillis: BigInt(60_000),
    });
    expect(sheet.speechMinute).toBe(creditMicrosToString(minute));
  });

  test("an override bills its base once, whatever the render's length", async () => {
    const video = request("video", { resolution: "720p", durationSeconds: 10 });
    const model = PROVIDERS.video.assetModelFor!(video)!;
    rows = [{ route: null, provider: PROVIDERS.video.id, model, baseCostMicros: BigInt(100_000) }];
    const sheet = await loadCreditPriceSheet(providerFor);
    expect(sheet.video["720p"]["10"]).toBe("0.1");
    expect(sheet.video["4k"]["4"]).toBe("0.1");
    expect(sheet.image).not.toBe("0.1");
  });
});
