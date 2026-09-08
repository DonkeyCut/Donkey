import { describe, expect, test } from "bun:test";
import { providerCreditPricing } from "@/lib/credits/provider-pricing";
import {
  geminiModels,
  geminiModelRoles,
  geminiMusicModels,
  geminiOmniModels,
  geminiTranscribeModels,
  geminiTtsModels,
} from "@/lib/inference/gemini-models";

describe("Gemini credit prices", () => {
  test("every hosted model and chat role has a price", () => {
    const catalogs = [
      ["gemini", geminiModels],
      ["gemini", geminiModelRoles],
      ["gemini", geminiTranscribeModels],
      ["gemini-music", geminiMusicModels],
      ["gemini-omni", geminiOmniModels],
      ["gemini-tts", geminiTtsModels],
    ] as const;
    for (const [provider, models] of catalogs) {
      for (const model of Object.values(models)) {
        expect(providerCreditPricing(provider, model)).toBeTruthy();
      }
    }
  });

  // Vertex global rates per million tokens, including Donkey's 30% margin.
  test("Flash-Lite 3.1 bills text, cached text, audio, and output at their rates", () => {
    const price = providerCreditPricing("gemini", geminiModels.flashLite);
    expect(price?.inputTokenCostMicrosPerMillion).toBe(BigInt(325000));
    expect(price?.cachedInputTokenCostMicrosPerMillion).toBe(BigInt(32500));
    expect(price?.inputAudioTokenCostMicrosPerMillion).toBe(BigInt(650000));
    expect(price?.outputTokenCostMicrosPerMillion).toBe(BigInt(1950000));
  });

  test("Flash 3.8 changes from launch to standard pricing at the UTC boundary", () => {
    const originalNow = Date.now;
    try {
      Date.now = () => Date.UTC(2026, 11, 31, 23, 59, 59, 999);
      const launch = providerCreditPricing("gemini", geminiModels.flash);
      expect(launch?.inputTokenCostMicrosPerMillion).toBe(BigInt(975000));
      expect(launch?.cachedInputTokenCostMicrosPerMillion).toBe(BigInt(97500));
      expect(launch?.inputAudioTokenCostMicrosPerMillion).toBe(BigInt(975000));
      expect(launch?.outputTokenCostMicrosPerMillion).toBe(BigInt(4875000));

      Date.now = () => Date.UTC(2027, 0, 1);
      const standard = providerCreditPricing("gemini", geminiModels.flash);
      expect(standard?.inputTokenCostMicrosPerMillion).toBe(BigInt(1950000));
      expect(standard?.cachedInputTokenCostMicrosPerMillion).toBe(BigInt(195000));
      expect(standard?.inputAudioTokenCostMicrosPerMillion).toBe(BigInt(1950000));
      expect(standard?.outputTokenCostMicrosPerMillion).toBe(BigInt(9750000));
    } finally {
      Date.now = originalNow;
    }
  });
});
