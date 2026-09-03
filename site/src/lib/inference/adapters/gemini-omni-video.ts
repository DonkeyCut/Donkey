import { GoogleGenAI } from "@google/genai";
import type { GoogleGenAIOptions, Interactions } from "@google/genai";

type Interaction = Interactions.Interaction;

import {
  constructGeminiClient,
  geminiApiError,
  geminiClientConfig,
  stringValue,
  type AdapterEnvironment,
} from "@/lib/inference/adapters/gemini-client";
import { providerCreditPricing } from "@/lib/credits/provider-pricing";
import {
  geminiOmniDefaultResolution,
  geminiOmniDurationSeconds,
  geminiOmniMaxReferenceImages,
  geminiOmniModels,
  geminiOmniResolutions,
  geminiOmniTokensPerSecond,
  geminiOmniUnitTokens,
  type GeminiOmniResolution,
} from "@/lib/inference/gemini-models";
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
  type JsonObject,
  type StoredGenerationForProvider,
} from "@/lib/inference/providers";

// The video generation provider (Gemini Omni Flash) on the Interactions API:
// one call takes text plus optional seed/reference images and renders a clip
// with audio in a single pass at the resolution asked for, at the length asked
// for or the model's own pick. It submits a background interaction and the
// caller polls refresh until it lands; the provider id keeps that refresh
// routing separate from the synchronous image adapter.
const providerID = "gemini-omni";

// Verified live against Vertex: `response_modalities` is rejected outright
// (400), so the requested output rides response_format alone; and image output
// is not enabled for this model, so this provider is video-only.
export type GeminiOmniClient = Pick<GoogleGenAI, "interactions">;
export type GeminiOmniClientFactory = (options: GoogleGenAIOptions) => GeminiOmniClient;

const defaultOmniClientFactory: GeminiOmniClientFactory = (options) =>
  constructGeminiClient(
    options,
    (opts) => new GoogleGenAI(opts),
    // Realize the interactions (NextGen) sub-client while the API-key env vars are
    // scrubbed, so its auth binds to the Vertex JWT instead of a stray env key.
    (client) => {
      void client.interactions;
    },
  );

export function createGeminiOmniVideoAssetProvider(
  environment: AdapterEnvironment = process.env,
  clientFactory: GeminiOmniClientFactory = defaultOmniClientFactory,
): InferenceProvider {
  const clientConfig = geminiClientConfig(environment);
  const configured = clientConfig.configured;
  const defaultModel = geminiOmniModels.flashVideo;

  async function listModels(
    modalities: InferenceModality[],
  ): Promise<InferenceModel[]> {
    if (!modalities.includes("video")) {
      return [];
    }
    return [
      {
        id: defaultModel,
        name: defaultModel,
        provider: providerID,
        inputModalities: ["text", "image"],
        outputModalities: ["video"],
        contextLength: null,
        pricing: null,
        metadata: { provider: providerID, api: "interactions" },
      },
    ];
  }

  function resolveModel(requested?: string): string {
    const model = requested?.trim() || defaultModel;
    // Fail before spending: the resolved model must have a configured price.
    if (!providerCreditPricing(providerID, model)) {
      throw new InferenceProviderError(
        "No credit price is configured for the selected video model.",
        { statusCode: 500, code: "video_model_not_priced", details: { model } },
      );
    }
    return model;
  }

  // The output size and length a request asks for, validated against the
  // registry: an unknown resolution or an out-of-range length is a caller bug,
  // refused before anything bills.
  function renderShape(parameters: JsonObject): {
    resolution: GeminiOmniResolution;
    durationSeconds: number | undefined;
  } {
    const asked = parameters.resolution;
    const resolutionRaw =
      asked === undefined || asked === null ? geminiOmniDefaultResolution : asked;
    if (
      typeof resolutionRaw !== "string" ||
      !(geminiOmniResolutions as readonly string[]).includes(resolutionRaw)
    ) {
      throw new InferenceProviderError("Unsupported video resolution.", {
        statusCode: 400,
        code: "unsupported_video_resolution",
        details: { resolution: resolutionRaw, supported: [...geminiOmniResolutions] },
      });
    }
    const durationRaw = parameters.durationSeconds;
    let durationSeconds: number | undefined;
    if (durationRaw !== undefined && durationRaw !== null) {
      const { min, max } = geminiOmniDurationSeconds;
      if (
        typeof durationRaw !== "number" ||
        !Number.isInteger(durationRaw) ||
        durationRaw < min ||
        durationRaw > max
      ) {
        throw new InferenceProviderError(
          `Video length must be a whole number of seconds from ${min} to ${max}.`,
          { statusCode: 400, code: "unsupported_video_duration", details: { durationSeconds: durationRaw } },
        );
      }
      durationSeconds = durationRaw;
    }
    return { resolution: resolutionRaw as GeminiOmniResolution, durationSeconds };
  }

  // Billing units for a request: seconds of 360p-equivalent output, from the
  // length (the model's ceiling when unset) times the resolution's tokens per
  // second. The route holds the balance to this count before the submit, and
  // the submit bills the same count.
  function generationUnits(parameters: JsonObject): number {
    const { resolution, durationSeconds } = renderShape(parameters);
    const seconds = durationSeconds ?? geminiOmniDurationSeconds.max;
    return Math.max(
      1,
      Math.ceil((seconds * geminiOmniTokensPerSecond[resolution]) / geminiOmniUnitTokens),
    );
  }

  async function generateAsset({
    request,
    generationCount,
  }: AssetGenerationProviderRequest): Promise<AssetGenerationProviderResult> {
    ensureConfigured(configured);

    if (request.kind !== "video") {
      throw new InferenceProviderError("Provider does not support this asset kind.", {
        statusCode: 400,
        code: "unsupported_asset_kind",
      });
    }

    const model = resolveModel(request.model);
    const basePrompt = request.prompt?.trim();
    const inputs = toJsonObject(request.inputs ?? {});
    const seed = firstInlineImage(inputs.images);
    // A render takes one conditioning mode: a seed frame XOR identity
    // references. Both at once is a caller bug — reject it rather than
    // silently dropping the identity anchors from a billed render.
    const references = inlineImages(inputs.referenceImages).slice(
      0,
      geminiOmniMaxReferenceImages,
    );
    if (seed && references.length > 0) {
      throw new InferenceProviderError(
        "Video generation takes an input image or reference images, not both.",
        { statusCode: 400, code: "conflicting_video_inputs" },
      );
    }
    if (!basePrompt && !seed) {
      throw new InferenceProviderError(
        "Video generation requires a prompt or an input image.",
        { statusCode: 400, code: "empty_video_request" },
      );
    }

    const parameters = toJsonObject(request.parameters ?? {});
    // The model has no negative-prompt parameter, so the bans ride the prompt
    // itself as an avoid clause — same treatment the image model gets.
    const negative = stringValue(parameters.negativePrompt)?.trim();
    const prompt = [basePrompt, negative ? `Avoid: ${negative}.` : ""]
      .filter(Boolean)
      .join(" ");
    const pictures = seed ? [seed] : references;
    const input =
      pictures.length === 0
        ? prompt
        : [
            ...pictures.map((image) => ({
              type: "image" as const,
              data: image.data,
              mime_type: image.mimeType as never,
            })),
            { type: "text" as const, text: prompt },
          ];
    const task = seed
      ? "image_to_video"
      : references.length > 0
        ? "reference_to_video"
        : "text_to_video";
    const aspectRatio = stringValue(parameters.aspectRatio);
    const { resolution, durationSeconds } = renderShape(parameters);
    // The route settles the count through assetGenerationCountFor and the
    // preflight holds the balance to it; a submit that recounted here would
    // bill a charge no preflight covered.
    const units = Math.floor(generationCount ?? 0);
    if (units < 1) {
      throw new InferenceProviderError("The video charge was not counted before submit.", {
        statusCode: 500,
        code: "video_charge_uncounted",
      });
    }

    const client = clientFactory(clientConfig.options);
    let interaction: Interaction;
    try {
      interaction = await client.interactions.create({
        model,
        input,
        // How the pictures condition the render: a seed becomes the opening
        // frame, references anchor identity/style across the clip.
        generation_config: { video_config: { task } } as never,
        response_format: {
          type: "video",
          resolution,
          ...(durationSeconds !== undefined ? { duration: `${durationSeconds}s` } : {}),
          ...(aspectRatio === "16:9" || aspectRatio === "9:16" ? { aspect_ratio: aspectRatio } : {}),
        } as never,
        background: true,
      });
    } catch (error) {
      throw geminiApiError("Omni video generation failed.", error);
    }

    // Rare fast path: the interaction may already be complete on submit.
    const settled = settledResult(interaction, interaction.id, model);
    if (settled) {
      return settled;
    }

    // In progress: the clip is committed, so its price bills now — the unit
    // count the requested length and resolution add up to (provider-pricing.ts),
    // since the async submit carries no token counts and the polls that follow
    // are free. Only the submit carries it; a refresh poll's in-progress result
    // must not.
    return { ...inProgressResult(interaction.id, model), usage: { generationCount: units } };
  }

  async function refreshAsset(
    generation: StoredGenerationForProvider,
  ): Promise<AssetGenerationProviderResult> {
    ensureConfigured(configured);

    const interactionId =
      generation.providerGenerationId?.trim() ||
      generation.providerJobId?.trim() ||
      stringValue(generation.metadata?.interactionId);
    if (!interactionId) {
      return failedResult(generation.model, "No Omni interaction to poll.");
    }

    const client = clientFactory(clientConfig.options);
    let interaction: Interaction;
    try {
      interaction = await client.interactions.get(interactionId);
    } catch (error) {
      throw geminiApiError("Polling the Omni interaction failed.", error);
    }

    return (
      settledResult(interaction, generation.id, generation.model) ??
      inProgressResult(interactionId, generation.model)
    );
  }

  function inProgressResult(
    interactionId: string,
    model: string,
  ): AssetGenerationProviderResult {
    return {
      provider: providerID,
      model,
      status: "in_progress",
      providerJobId: interactionId,
      providerGenerationId: interactionId,
      providerPollingUrl: interactionId,
      outputs: [],
      metadata: { provider: providerID, api: "interactions", interactionId },
    };
  }

  function failedResult(model: string, message: string): AssetGenerationProviderResult {
    return {
      provider: providerID,
      model,
      status: "failed",
      outputs: [],
      error: { message },
      metadata: { provider: providerID, api: "interactions" },
    };
  }

  // A completed or failed interaction mapped to a provider result; undefined
  // while it is still running. The clip was billed flat at submit; the token
  // counts here ride the result as diagnostics, not a charge.
  function settledResult(
    interaction: Interaction,
    generationId: string,
    model: string,
  ): AssetGenerationProviderResult | undefined {
    if (interaction.status === "in_progress" || interaction.status === "requires_action") {
      return undefined;
    }
    const video = interaction.output_video;
    if (interaction.status !== "completed" || !video || (!video.data && !video.uri)) {
      return failedResult(
        model,
        interactionError(interaction) ?? "Omni returned no video for this request.",
      );
    }
    const mimeType = video.mime_type ?? "video/mp4";
    const output: GenerationOutputRef = {
      id: `${generationId}-video-0`,
      kind: "video",
      contentType: mimeType,
      filename: `${generationId}-0.mp4`,
      metadata: { source: "provider-output" },
      ...(video.data ? { dataBase64: video.data } : { url: video.uri }),
    };
    const usage = interaction.usage;
    return {
      provider: providerID,
      model,
      status: "completed",
      outputs: [output],
      usage: {
        inputTokens: usage?.total_input_tokens ?? 0,
        // Thought tokens bill as output; video tokens dominate either way.
        outputTokens: (usage?.total_output_tokens ?? 0) + (usage?.total_thought_tokens ?? 0),
      },
      metadata: { provider: providerID, api: "interactions" },
    };
  }

  return {
    id: providerID,
    configured,
    capabilities: ["video"],
    listModels,
    assetModelFor: (request) => resolveModel(request.model),
    // Seconds of output, read off the parameters alone: the resolver goes
    // untouched so a seed frame never leaves storage before the balance clears.
    assetGenerationCountFor: async (request) =>
      generationUnits(toJsonObject(request.parameters ?? {})),
    generateAsset,
    refreshAsset,
  };
}

type InlineImage = { data: string; mimeType: string };

// The video tools send a seed frame as inputs.images = [{ data, mimeType }]
// and identity anchors as inputs.referenceImages.
function firstInlineImage(list: unknown): InlineImage | undefined {
  return inlineImages(list)[0];
}

function inlineImages(list: unknown): InlineImage[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const out: InlineImage[] = [];
  for (const item of list) {
    if (!isJsonObject(item)) {
      continue;
    }
    const data = stringValue(item.data);
    if (!data) {
      continue;
    }
    out.push({ data, mimeType: stringValue(item.mimeType) ?? "image/png" });
  }
  return out;
}

// A failed interaction carries its reason on the last model_output step.
function interactionError(interaction: Interaction): string | undefined {
  for (const step of [...(interaction.steps ?? [])].reverse()) {
    const error = (step as unknown as JsonObject).error;
    if (isJsonObject(error)) {
      const message = stringValue(error.message);
      if (message) {
        return message;
      }
    }
  }
  return undefined;
}
