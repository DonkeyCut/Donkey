import { Modality } from "@google/genai";
import type { GenerateContentParameters } from "@google/genai";

import {
  defaultGeminiClientFactory,
  geminiApiError,
  geminiCandidateParts,
  geminiCandidates,
  geminiClientConfig,
  stringValue,
  type AdapterEnvironment,
  type GeminiClientFactory,
} from "@/lib/inference/adapters/gemini-client";
import { providerCreditPricing } from "@/lib/credits/provider-pricing";
import { geminiTtsModels } from "@/lib/inference/gemini-models";
import { ensureConfigured } from "@/lib/inference/http";
import { isJsonObject, toJsonObject } from "@/lib/inference/json";
import {
  InferenceProviderError,
  type AssetGenerationProviderRequest,
  type AssetGenerationProviderResult,
  type GenerationOutputRef,
  type InferenceModality,
  type InferenceModel,
  type InferenceProvider,
  type JsonValue,
  type StoredGenerationForProvider,
} from "@/lib/inference/providers";

// Generative speech provider (Gemini TTS). The registry auto-selects it for
// kind="speech" when the caller leaves the provider unset. Synchronous like the
// image adapter — one generateContent call returns the finished audio. A DISTINCT
// provider id keeps refresh routing from colliding with the image adapter.
const providerID = "gemini-tts";

// The prompt is what gets spoken; callers steer style, pace, and tone by
// prefixing a natural-language direction ("Say in a spooky whisper: …") or
// embedding inline audio tags ("[excited]", "[whispers]") in the text.
const defaultVoice = "Kore";

export function createGeminiSpeechAssetProvider(
  environment: AdapterEnvironment = process.env,
  clientFactory: GeminiClientFactory = defaultGeminiClientFactory,
): InferenceProvider {
  const clientConfig = geminiClientConfig(environment);
  const configured = clientConfig.configured;
  const defaultModel = geminiTtsModels.flash;

  async function listModels(
    modalities: InferenceModality[],
  ): Promise<InferenceModel[]> {
    if (!modalities.includes("speech") && !modalities.includes("audio")) {
      return [];
    }
    return [
      {
        id: defaultModel,
        name: defaultModel,
        provider: providerID,
        inputModalities: ["text"],
        outputModalities: ["audio"],
        contextLength: null,
        pricing: null,
        metadata: { provider: providerID, api: "generateContent" },
      },
    ];
  }

  function resolveModel(requested?: string): string {
    const model = requested?.trim() || defaultModel;
    // Fail before spending: a caller-supplied model may resolve to an id with no
    // configured price — never run a generation we can't charge for.
    if (!providerCreditPricing(providerID, model)) {
      throw new InferenceProviderError(
        "No credit price is configured for the selected speech model.",
        { statusCode: 500, code: "speech_model_not_priced", details: { model } },
      );
    }
    return model;
  }

  async function generateAsset({
    generationId,
    request,
  }: AssetGenerationProviderRequest): Promise<AssetGenerationProviderResult> {
    ensureConfigured(configured);

    if (request.kind !== "speech") {
      throw new InferenceProviderError("Provider does not support this asset kind.", {
        statusCode: 400,
        code: "unsupported_asset_kind",
      });
    }

    const model = resolveModel(request.model);

    const prompt = request.prompt?.trim();
    if (!prompt) {
      throw new InferenceProviderError("Speech generation requires text to speak.", {
        statusCode: 400,
        code: "empty_speech_request",
      });
    }

    const inputs = toJsonObject(request.inputs ?? {});
    const parameters = toJsonObject(request.parameters ?? {});
    const voice =
      stringValue(inputs.voice) ?? stringValue(parameters.voice) ?? defaultVoice;
    const languageCode = stringValue(parameters.languageCode);

    const params: GenerateContentParameters = {
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          ...(languageCode ? { languageCode } : {}),
        },
      },
    };
    const client = clientFactory(clientConfig.options);

    // The TTS model intermittently returns a well-formed response with an empty
    // candidate (no audio, finishReason STOP or null) — the model stops before
    // speaking, most often on short or heavily punctuated text. It is
    // nondeterministic per call, so a resend usually clears it; retry a few
    // times before failing, but never retry a permanent block (safety,
    // recitation), which repeats forever and only burns quota.
    const maxAttempts = 4;
    let outputs: GenerationOutputRef[] = [];
    let finishReason: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let rawResponse: unknown;
      try {
        rawResponse = await client.models.generateContent(params);
      } catch (error) {
        throw geminiApiError("Gemini speech generation failed.", error);
      }

      outputs = audioOutputs(rawResponse as JsonValue, generationId);
      if (outputs.length > 0) {
        break;
      }
      finishReason = speechFinishReason(rawResponse as JsonValue);
      if (attempt >= maxAttempts || isPermanentSpeechBlock(finishReason)) {
        break;
      }
    }

    if (outputs.length === 0) {
      // A well-formed response with no audio means the model stopped before
      // speaking — a permanent safety/recitation block, or a transient hiccup
      // that outlasted the retries. Surface the finishReason so the empty
      // result is diagnosable instead of opaque.
      throw new InferenceProviderError("Gemini returned no audio for this request.", {
        statusCode: 502,
        code: "empty_speech_generation",
        details: { model, finishReason: finishReason ?? null },
      });
    }

    return {
      provider: providerID,
      model,
      status: "completed",
      outputs,
      usage: { durationMillis: outputDurationMillis(outputs) },
      metadata: { provider: providerID, api: "generateContent", voice },
    };
  }

  async function refreshAsset(
    generation: StoredGenerationForProvider,
  ): Promise<AssetGenerationProviderResult> {
    // Speech generation is synchronous — there is nothing to poll. Echo the stored
    // outputs as completed so the refresh route stays valid for any caller that polls.
    return {
      provider: providerID,
      model: generation.model,
      status: "completed",
      outputs: generation.outputs,
      metadata: { provider: providerID, api: "generateContent" },
    };
  }

  return {
    id: providerID,
    configured,
    capabilities: ["speech"],
    listModels,
    assetModelFor: (request) => resolveModel(request.model),
    generateAsset,
    refreshAsset,
  };
}

// The finishReason of the first candidate, if any — the model's own account of
// why it stopped (e.g. "SAFETY", "RECITATION", "STOP"). Read only to explain an
// empty audio response; never affects a successful generation.
function speechFinishReason(raw: JsonValue): string | undefined {
  for (const candidate of geminiCandidates(raw)) {
    const reason = stringValue(candidate.finishReason);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

// finishReasons where the model deliberately refused to speak. Resending the
// same text just hits the same wall, so an empty response with one of these is
// final and must not be retried.
const permanentSpeechBlocks = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
]);

function isPermanentSpeechBlock(finishReason: string | undefined): boolean {
  return finishReason !== undefined && permanentSpeechBlocks.has(finishReason);
}

// Gemini TTS returns raw little-endian 16-bit mono PCM (audio/L16), 24 kHz by default.
const defaultSampleRate = 24_000;

function audioOutputs(raw: JsonValue, generationId: string): GenerationOutputRef[] {
  const outputs: GenerationOutputRef[] = [];
  let index = 0;
  for (const candidate of geminiCandidates(raw)) {
    for (const part of geminiCandidateParts(candidate)) {
      const inline = part.inlineData ?? part.inline_data;
      if (!isJsonObject(inline)) {
        continue;
      }
      const data = stringValue(inline.data);
      if (!data) {
        continue;
      }
      const mimeType =
        stringValue(inline.mimeType) ??
        stringValue(inline.mime_type) ??
        `audio/L16;codec=pcm;rate=${defaultSampleRate}`;
      outputs.push({
        id: `${generationId}-speech-${index}`,
        kind: "audio",
        dataBase64: data,
        contentType: mimeType,
        filename: `${generationId}-${index}.pcm`,
        byteCount: base64ByteCount(data),
        metadata: { source: "provider-output" },
      });
      index += 1;
    }
  }
  return outputs;
}

// Billable seconds of audio, derived from the PCM payload itself (bytes over
// sampleRate × 2 bytes per sample). The TTS response carries no usable
// usageMetadata for billing, so the payload is the source of truth.
function outputDurationMillis(outputs: GenerationOutputRef[]): number {
  let millis = 0;
  for (const output of outputs) {
    const bytes = output.byteCount ?? 0;
    const rate = sampleRateFromMime(output.contentType) ?? defaultSampleRate;
    millis += Math.ceil((bytes / (rate * 2)) * 1000);
  }
  return millis;
}

function sampleRateFromMime(mimeType: string | undefined): number | undefined {
  const match = mimeType?.match(/rate=(\d+)/);
  if (!match) {
    return undefined;
  }
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

function base64ByteCount(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}
