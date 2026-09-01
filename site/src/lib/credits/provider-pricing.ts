import {
  creditStringToMicros,
  zeroCreditMicros,
} from "@/lib/credits/amounts";
import {
  elevenLabsModels,
  type ElevenLabsRunModel,
} from "@/lib/inference/elevenlabs-models";
import {
  geminiModels,
  geminiMusicModels,
  geminiOmniModels,
  geminiTtsModels,
  type GeminiModel,
  type GeminiMusicModel,
  type GeminiOmniModel,
  type GeminiTtsModel,
} from "@/lib/inference/gemini-models";
import { falMatteModels, type FalMatteModel } from "@/lib/inference/matte-models";

export type ProviderCreditPricing = {
  inputTokenCostMicrosPerMillion?: bigint;
  cachedInputTokenCostMicrosPerMillion?: bigint;
  outputTokenCostMicrosPerMillion?: bigint;
  inputAudioTokenCostMicrosPerMillion?: bigint;
  cachedInputAudioTokenCostMicrosPerMillion?: bigint;
  outputAudioTokenCostMicrosPerMillion?: bigint;
  characterCostMicros?: bigint;
  durationSecondCostMicros?: bigint;
  durationCostOnlyWhenNoTokenUsage?: boolean;
  generationCostMicros?: bigint;
  longContextThresholdTokens?: bigint;
  longContext?: Omit<ProviderCreditPricing, "longContext" | "longContextThresholdTokens">;
};

const providerMarginNumerator = BigInt(13);
const providerMarginDenominator = BigInt(10);
const openAILongContextThresholdTokens = BigInt(272000);

export function providerCreditPricing(
  provider: string,
  model: string,
): ProviderCreditPricing | undefined {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();

  if (normalizedProvider === "openai") {
    return openAICreditPricing(normalizedModel);
  }
  if (normalizedProvider === "gemini") {
    return geminiCreditPricing(normalizedModel);
  }
  // Gemini TTS ids are hardcoded (gemini-models.ts); speech bills per second of audio.
  if (normalizedProvider === "gemini-tts") {
    return geminiTtsCreditPricing(normalizedModel);
  }
  // Omni video ids are hardcoded (gemini-models.ts); a clip bills flat at submit.
  if (normalizedProvider === "gemini-omni") {
    return geminiOmniCreditPricing(normalizedModel);
  }
  // Lyria music ids are hardcoded (gemini-models.ts); a clip bills flat per render.
  if (normalizedProvider === "gemini-music") {
    return geminiMusicCreditPricing(normalizedModel);
  }
  if (normalizedProvider === "elevenlabs") {
    return elevenLabsCreditPricing(normalizedModel);
  }
  // The matte segmenter id is hardcoded (matte-models.ts); a matte bills at
  // submit, one generation per 16-frame chunk of the segment.
  if (normalizedProvider === "fal") {
    return falMatteCreditPricing(normalizedModel);
  }

  return undefined;
}

function openAICreditPricing(model: string): ProviderCreditPricing | undefined {
  const audioPricing = openAIAudioCreditPricing(model);
  if (audioPricing) {
    return audioPricing;
  }

  const matched = openAITextCreditRates.find((rate) => modelMatches(model, rate.model));
  if (!matched) {
    return undefined;
  }

  return textTokenPricing(matched);
}

function openAIAudioCreditPricing(model: string): ProviderCreditPricing | undefined {
  if (modelMatches(model, "gpt-realtime-2")) {
    return textAudioTokenPricing({
      input: "4",
      cachedInput: "0.4",
      output: "24",
      inputAudio: "32",
      cachedInputAudio: "0.4",
      outputAudio: "64",
    });
  }
  if (modelMatches(model, "gpt-realtime-1.5")) {
    return textAudioTokenPricing({
      input: "4",
      cachedInput: "0.4",
      output: "16",
      inputAudio: "32",
      cachedInputAudio: "0.4",
      outputAudio: "64",
    });
  }
  if (modelMatches(model, "gpt-realtime-mini")) {
    return textAudioTokenPricing({
      input: "0.6",
      cachedInput: "0.06",
      output: "2.4",
      inputAudio: "10",
      cachedInputAudio: "0.3",
      outputAudio: "20",
    });
  }
  if (modelMatches(model, "gpt-4o-mini-audio-preview")) {
    return textAudioTokenPricing({
      input: "0.15",
      output: "0.6",
      inputAudio: "10",
      outputAudio: "20",
    });
  }
  if (modelMatches(model, "gpt-4o-audio-preview")) {
    return textAudioTokenPricing({
      input: "2.5",
      output: "10",
      inputAudio: "40",
      outputAudio: "80",
    });
  }
  if (modelMatches(model, "gpt-audio-mini")) {
    return textAudioTokenPricing({
      input: "0.6",
      output: "2.4",
    });
  }
  if (modelMatches(model, "gpt-audio")) {
    return textAudioTokenPricing({
      input: "2.5",
      output: "10",
      inputAudio: "32",
      outputAudio: "64",
    });
  }
  if (modelMatches(model, "gpt-4o-transcribe")) {
    return textTokenPricing({
      model: "gpt-4o-transcribe",
      input: "2.5",
      output: "10",
      durationSecond: "0.0001",
      durationCostOnlyWhenNoTokenUsage: true,
    });
  }
  if (modelMatches(model, "gpt-4o-mini-transcribe")) {
    return textTokenPricing({
      model: "gpt-4o-mini-transcribe",
      input: "1.25",
      output: "5",
      durationSecond: "0.00005",
      durationCostOnlyWhenNoTokenUsage: true,
    });
  }

  return undefined;
}

const openAITextCreditRates: {
  model: string;
  input: string;
  cachedInput?: string;
  output: string;
  durationSecond?: string;
  durationCostOnlyWhenNoTokenUsage?: boolean;
  longContext?: {
    input: string;
    cachedInput?: string;
    output: string;
  };
}[] = [
  {
    model: "gpt-5.5-pro",
    input: "30",
    output: "180",
    longContext: {
      input: "60",
      output: "270",
    },
  },
  // gpt-5.5 and gpt-5.4 are gateway-run models — priced in openaiRunModelPricing.
  {
    model: "gpt-5.4-pro",
    input: "30",
    output: "180",
    longContext: {
      input: "60",
      output: "270",
    },
  },
  {
    model: "gpt-5.4-mini",
    input: "0.75",
    cachedInput: "0.075",
    output: "4.5",
  },
  {
    model: "gpt-5.4-nano",
    input: "0.2",
    cachedInput: "0.02",
    output: "1.25",
  },
  { model: "gpt-5.2-pro", input: "21", output: "168" },
  { model: "gpt-5.2", input: "1.75", cachedInput: "0.175", output: "14" },
  { model: "gpt-5.1", input: "1.25", cachedInput: "0.125", output: "10" },
  { model: "gpt-5-pro", input: "15", output: "120" },
  { model: "gpt-5-mini", input: "0.25", cachedInput: "0.025", output: "2" },
  { model: "gpt-5-nano", input: "0.05", cachedInput: "0.005", output: "0.4" },
  { model: "gpt-5", input: "1.25", cachedInput: "0.125", output: "10" },
  { model: "chat-latest", input: "5", cachedInput: "0.5", output: "30" },
  { model: "chatgpt-5-latest", input: "5", cachedInput: "0.5", output: "30" },
  { model: "gpt-4.1-mini", input: "0.4", cachedInput: "0.1", output: "1.6" },
  { model: "gpt-4.1-nano", input: "0.1", cachedInput: "0.025", output: "0.4" },
  { model: "gpt-4.1", input: "2", cachedInput: "0.5", output: "8" },
  { model: "gpt-4o-mini", input: "0.15", cachedInput: "0.075", output: "0.6" },
  { model: "gpt-4o-2024-05-13", input: "5", output: "15" },
  { model: "gpt-4o", input: "2.5", cachedInput: "1.25", output: "10" },
  { model: "o1-pro", input: "150", output: "600" },
  { model: "o1-mini", input: "1.1", cachedInput: "0.55", output: "4.4" },
  { model: "o1", input: "15", cachedInput: "7.5", output: "60" },
  { model: "o3-pro", input: "20", output: "80" },
  { model: "o3-mini", input: "1.1", cachedInput: "0.55", output: "4.4" },
  { model: "o3", input: "2", cachedInput: "0.5", output: "8" },
  { model: "o4-mini", input: "1.1", cachedInput: "0.275", output: "4.4" },
];

// gemini-3.7-flash launch pricing runs through 2026-12-31; standard pricing
// starts 2027-01-01 UTC. Audio input bills at the text rate. The record entry
// is a getter, so every lookup reads the clock and the switch happens on
// schedule without a deploy.
const geminiFlashStandardPricingStartMs = Date.UTC(2027, 0, 1);
const geminiFlashLaunchPricing = textAudioTokenPricing({
  input: "0.75",
  cachedInput: "0.075",
  output: "3.75",
  inputAudio: "0.75",
});
const geminiFlashStandardPricing = textAudioTokenPricing({
  input: "1.5",
  cachedInput: "0.15",
  output: "7.5",
  inputAudio: "1.5",
});

// Every Gemini model we run must appear here: the Record is keyed by the GeminiModel union,
// so adding a model to gemini-models.ts without a price fails the type-check (and the build).
const geminiModelPricing: Record<GeminiModel, ProviderCreditPricing> = {
  get [geminiModels.flash]() {
    return Date.now() >= geminiFlashStandardPricingStartMs
      ? geminiFlashStandardPricing
      : geminiFlashLaunchPricing;
  },
  [geminiModels.flashLite]: textAudioTokenPricing({
    input: "0.25",
    cachedInput: "0.025",
    output: "1.5",
    inputAudio: "0.5",
  }),
  // Generative image editing/generation ("nano banana") bills per output image:
  // ~1290 output tokens at $30/1M ≈ $0.039 each.
  [geminiModels.flashImage]: { generationCostMicros: usdWithMargin("0.039") },
  // "Nano banana pro" bills per output image by resolution: $0.134 at 1K/2K, $0.24 at
  // 4K. Our per-image price can't vary by resolution, so this charges the 1K/2K rate
  // (the default is 2K); 4K currently under-bills. Make billing resolution-aware before
  // relying on heavy 4K use.
  [geminiModels.proImage]: { generationCostMicros: usdWithMargin("0.134") },
};

// Generative speech (Gemini TTS) bills by seconds of synthesized audio: audio out runs
// $20/1M tokens at ~25 tokens per second ≈ $0.0005/s; the tiny text input rides along.
// The Record is keyed by GeminiTtsModel, so adding a TTS id without a price fails the build.
const geminiTtsModelPricing: Record<GeminiTtsModel, ProviderCreditPricing> = {
  [geminiTtsModels.flash]: { durationSecondCostMicros: usdWithMargin("0.0005") },
};

function geminiTtsCreditPricing(model: string): ProviderCreditPricing | undefined {
  return geminiTtsModelPricing[model as GeminiTtsModel];
}

// Unified video generation (Gemini Omni Flash). The provider bills by tokens —
// $1.50/1M input, $17.50/1M output, and a rendered second of 720p video is
// 5,792 output tokens — but the render is async: the submit response carries no
// token counts, and charging on the completing poll instead would let one
// balance launch unbounded concurrent renders. So a clip charges FLAT at
// submit (usage {generationCount: 1}): ~10s × 5,792 tokens/s × $17.5/1M ≈
// $1.02, the model's fixed-length output. The token rates stay for the rare
// interaction that completes synchronously with real counts. The Record is
// keyed by GeminiOmniModel, so adding an Omni id without a price fails the build.
const geminiOmniModelPricing: Record<GeminiOmniModel, ProviderCreditPricing> = {
  [geminiOmniModels.flashVideo]: {
    ...textTokenPricing({
      model: geminiOmniModels.flashVideo,
      input: "1.5",
      output: "17.5",
    }),
    generationCostMicros: usdWithMargin("1.02"),
  },
};

function geminiOmniCreditPricing(model: string): ProviderCreditPricing | undefined {
  return geminiOmniModelPricing[model as GeminiOmniModel];
}

// The matte segmenter bills upstream per 16 processed frames ($0.005 a
// chunk); the adapter counts the submitted segment's frames and charges the
// same unit, generationCount = started chunks. Each model meters its own
// chunk size (the adapter's matteChunkFrames): the segmenter per 16 frames,
// the removal model per 30 frames with edge refinement on. Keyed by
// FalMatteModel, so adding a matte id without a price fails the build.
const falMatteModelPricing: Record<FalMatteModel, ProviderCreditPricing> = {
  [falMatteModels.segmenter]: { generationCostMicros: usdWithMargin("0.005") },
  [falMatteModels.removal]: { generationCostMicros: usdWithMargin("0.0225") },
};

function falMatteCreditPricing(model: string): ProviderCreditPricing | undefined {
  return falMatteModelPricing[model as FalMatteModel];
}

// Generative music (Gemini/Lyria) bills flat per rendered clip: the render is a
// fixed-length interaction that carries no per-second usage, so a clip charges
// generationCount = 1 at completion. Rates are Lyria 3's published per-request
// prices ($0.04 clip, $0.08 full song); usdWithMargin adds the 1.3x. The Record
// is keyed by GeminiMusicModel, so adding a Lyria id without a price fails the build.
const geminiMusicModelPricing: Record<GeminiMusicModel, ProviderCreditPricing> = {
  [geminiMusicModels.clip]: { generationCostMicros: usdWithMargin("0.04") },
  [geminiMusicModels.pro]: { generationCostMicros: usdWithMargin("0.08") },
};

function geminiMusicCreditPricing(model: string): ProviderCreditPricing | undefined {
  const exact = geminiMusicModelPricing[model as GeminiMusicModel];
  if (exact) {
    return exact;
  }
  for (const [id, pricing] of Object.entries(geminiMusicModelPricing)) {
    if (modelMatches(model, id)) {
      return pricing;
    }
  }
  return undefined;
}

function geminiCreditPricing(model: string): ProviderCreditPricing | undefined {
  // Exact match wins, so a specific id is never shadowed by a broader prefix entry (e.g. an image
  // model "…-flash-image" under the "…-flash" text prefix). For dated/snapshot ids that only match
  // by prefix, try the longest (most specific) key first for the same reason.
  const exact = geminiModelPricing[model as GeminiModel];
  if (exact) {
    return exact;
  }

  const byLongestPrefix = Object.entries(geminiModelPricing).sort(
    ([a], [b]) => b.length - a.length,
  );
  for (const [id, pricing] of byLongestPrefix) {
    if (modelMatches(model, id)) {
      return pricing;
    }
  }

  return undefined;
}

// Every ElevenLabs model the gateway selects must appear here: the Record is keyed by the
// ElevenLabsRunModel union, so adding a run model without a price fails the build.
const elevenLabsRunModelPricing: Record<ElevenLabsRunModel, ProviderCreditPricing> = {
  [elevenLabsModels.music]: { durationSecondCostMicros: usdWithMargin("0.005") },
};

function elevenLabsCreditPricing(model: string): ProviderCreditPricing | undefined {
  const runModelPricing = elevenLabsRunModelPricing[model as ElevenLabsRunModel];
  if (runModelPricing) {
    return runModelPricing;
  }
  if (modelMatches(model, "eleven_text_to_sound_v2")) {
    return {
      characterCostMicros: usdWithMargin("0.00005"),
      durationSecondCostMicros: usdWithMargin("0.002"),
    };
  }
  if (
    modelMatches(model, "eleven_flash_v2_5") ||
    modelMatches(model, "eleven_flash_v2") ||
    modelMatches(model, "eleven_turbo_v2_5") ||
    modelMatches(model, "eleven_turbo_v2")
  ) {
    return {
      characterCostMicros: usdWithMargin("0.00005"),
    };
  }
  if (
    modelMatches(model, "eleven_v3") ||
    modelMatches(model, "eleven_multilingual_v2") ||
    modelMatches(model, "eleven_multilingual_v1") ||
    modelMatches(model, "eleven_monolingual_v1")
  ) {
    return {
      characterCostMicros: usdWithMargin("0.0001"),
    };
  }

  return undefined;
}

function modelMatches(model: string, rateModel: string) {
  return model === rateModel || model.startsWith(`${rateModel}-`);
}

function textTokenPricing(rate: {
  model: string;
  input: string;
  cachedInput?: string;
  output: string;
  durationSecond?: string;
  durationCostOnlyWhenNoTokenUsage?: boolean;
  longContext?: {
    input: string;
    cachedInput?: string;
    output: string;
  };
}): ProviderCreditPricing {
  return {
    inputTokenCostMicrosPerMillion: usdPerMillionWithMargin(rate.input),
    cachedInputTokenCostMicrosPerMillion: rate.cachedInput
      ? usdPerMillionWithMargin(rate.cachedInput)
      : undefined,
    outputTokenCostMicrosPerMillion: usdPerMillionWithMargin(rate.output),
    durationSecondCostMicros: rate.durationSecond
      ? usdWithMargin(rate.durationSecond)
      : undefined,
    durationCostOnlyWhenNoTokenUsage: rate.durationCostOnlyWhenNoTokenUsage,
    longContextThresholdTokens: rate.longContext
      ? openAILongContextThresholdTokens
      : undefined,
    longContext: rate.longContext
      ? {
          inputTokenCostMicrosPerMillion: usdPerMillionWithMargin(
            rate.longContext.input,
          ),
          cachedInputTokenCostMicrosPerMillion: rate.longContext.cachedInput
            ? usdPerMillionWithMargin(rate.longContext.cachedInput)
            : undefined,
          outputTokenCostMicrosPerMillion: usdPerMillionWithMargin(
            rate.longContext.output,
          ),
        }
      : undefined,
  };
}

function textAudioTokenPricing(rate: {
  input: string;
  cachedInput?: string;
  output: string;
  inputAudio?: string;
  cachedInputAudio?: string;
  outputAudio?: string;
  longContextThresholdTokens?: bigint;
  longContext?: ProviderCreditPricing["longContext"];
}): ProviderCreditPricing {
  return {
    inputTokenCostMicrosPerMillion: usdPerMillionWithMargin(rate.input),
    cachedInputTokenCostMicrosPerMillion: rate.cachedInput
      ? usdPerMillionWithMargin(rate.cachedInput)
      : undefined,
    outputTokenCostMicrosPerMillion: usdPerMillionWithMargin(rate.output),
    inputAudioTokenCostMicrosPerMillion: rate.inputAudio
      ? usdPerMillionWithMargin(rate.inputAudio)
      : undefined,
    cachedInputAudioTokenCostMicrosPerMillion: rate.cachedInputAudio
      ? usdPerMillionWithMargin(rate.cachedInputAudio)
      : undefined,
    outputAudioTokenCostMicrosPerMillion: rate.outputAudio
      ? usdPerMillionWithMargin(rate.outputAudio)
      : undefined,
    longContextThresholdTokens: rate.longContextThresholdTokens,
    longContext: rate.longContext,
  };
}

function usdPerMillionWithMargin(value: string) {
  return usdWithMargin(value);
}

function usdWithMargin(value: string) {
  return ceilDivide(
    creditStringToMicros(value) * providerMarginNumerator,
    providerMarginDenominator,
  );
}

function ceilDivide(numerator: bigint, denominator: bigint) {
  if (denominator <= zeroCreditMicros) {
    throw new Error("Cannot divide by zero.");
  }
  if (numerator <= zeroCreditMicros) {
    return zeroCreditMicros;
  }

  return (numerator + denominator - BigInt(1)) / denominator;
}
