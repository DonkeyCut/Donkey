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
import { geminiModels, geminiMusicModels } from "@/lib/inference/gemini-models";
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

// The music generation provider (Gemini/Lyria) on the Interactions API: one call
// takes a text prompt and renders an instrumental clip — the background bed for a
// cut. Same Interactions surface as the Omni video adapter and the same Vertex
// service-account client (the legacy Lyria interaction models run on Vertex,
// unlike Lyria RealTime, the live WebSocket API, which Vertex rejects).
//
// Lyria renders synchronously — it rejects background interactions, so the create
// call blocks until the clip is ready and returns the finished audio inline (like
// the speech adapter). generateAsset still tolerates an in_progress result by
// polling, as a safety net. The provider id keeps refresh routing separate from
// the other Gemini adapters. Note: Lyria takes no response_format (a music model
// defaults to audio; passing one 400s) and filters prompts strictly.
const providerID = "gemini-music";

// How long generateAsset waits for a clip before giving up, and how often it
// polls. Bounded under the shared client's 120s request timeout so a stuck
// render can't hold the route open forever; a clip renders well inside it.
const MAX_WAIT_MS = 110_000;
const POLL_MS = 4_000;

// The clip model's fixed length; a requested bed longer than this renders on the
// pro model instead so the placed (trimmed) track can still span the video.
const CLIP_SECONDS = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `models` is used to rewrite a policy-blocked prompt into a safe description.
export type GeminiMusicClient = Pick<GoogleGenAI, "interactions" | "models">;
export type GeminiMusicClientFactory = (options: GoogleGenAIOptions) => GeminiMusicClient;

const defaultMusicClientFactory: GeminiMusicClientFactory = (options) =>
  constructGeminiClient(
    options,
    (opts) => new GoogleGenAI(opts),
    // Realize the interactions (NextGen) sub-client while the API-key env vars are
    // scrubbed, so its auth binds to the Vertex JWT instead of a stray env key.
    (client) => {
      void client.interactions;
    },
  );

export function createGeminiMusicAssetProvider(
  environment: AdapterEnvironment = process.env,
  clientFactory: GeminiMusicClientFactory = defaultMusicClientFactory,
): InferenceProvider {
  const clientConfig = geminiClientConfig(environment);
  const configured = clientConfig.configured;

  async function listModels(
    modalities: InferenceModality[],
  ): Promise<InferenceModel[]> {
    if (!modalities.includes("music") && !modalities.includes("audio")) {
      return [];
    }
    return [geminiMusicModels.clip, geminiMusicModels.pro].map((id) => ({
      id,
      name: id,
      provider: providerID,
      inputModalities: ["text"],
      outputModalities: ["music"],
      contextLength: null,
      pricing: null,
      metadata: { provider: providerID, api: "interactions" },
    }));
  }

  // The clip model renders a fixed short clip; the pro model a full-length track.
  // The Audio-tab generator steers length with a neutral `variant` ("clip"|"song");
  // the brief-to-video bed instead posts the video's `durationSeconds` with no
  // variant — so pick the longer pro model past the clip's fixed length, letting
  // the placed (and trimmed) bed span the video. Model ids stay in this adapter.
  function resolveModel(requested: string | undefined, parameters: JsonObject): string {
    const variant = stringValue(parameters.variant);
    const durationSeconds =
      typeof parameters.durationSeconds === "number" ? parameters.durationSeconds : undefined;
    const long =
      variant === "song" ||
      (variant === undefined && durationSeconds !== undefined && durationSeconds > CLIP_SECONDS);
    const model = requested?.trim() || (long ? geminiMusicModels.pro : geminiMusicModels.clip);
    // Fail before spending: the resolved model must have a configured price.
    if (!providerCreditPricing(providerID, model)) {
      throw new InferenceProviderError(
        "No credit price is configured for the selected music model.",
        { statusCode: 500, code: "music_model_not_priced", details: { model } },
      );
    }
    return model;
  }

  async function generateAsset({
    generationId,
    request,
  }: AssetGenerationProviderRequest): Promise<AssetGenerationProviderResult> {
    ensureConfigured(configured);

    if (request.kind !== "music") {
      throw new InferenceProviderError("Provider does not support this asset kind.", {
        statusCode: 400,
        code: "unsupported_asset_kind",
      });
    }

    const parameters = toJsonObject(request.parameters ?? {});
    const model = resolveModel(request.model, parameters);
    const prompt = request.prompt?.trim();
    if (!prompt) {
      throw new InferenceProviderError("Music generation requires a prompt.", {
        statusCode: 400,
        code: "empty_music_request",
      });
    }

    const client = clientFactory(clientConfig.options);
    let interaction: Interaction;
    try {
      // No background and no response_format: Lyria rejects both. The create call
      // blocks until the clip renders and comes back completed.
      interaction = await client.interactions.create({ model, input: prompt });
    } catch (error) {
      // Lyria blocks prompts that name a real artist, band, song, or brand.
      // Rather than fail, have a model rewrite the ask into a description of the
      // SOUND (traits, not names — an LLM does it, never string matching) and try
      // once more. This mirrors the video pipeline's "describe by traits" rule.
      if (!isContentBlock(error)) throw geminiApiError("Music generation failed.", error);
      const rewritten = await rewritePrompt(client, prompt);
      if (!rewritten) throw promptBlockedError();
      try {
        interaction = await client.interactions.create({ model, input: rewritten });
      } catch (retryError) {
        if (isContentBlock(retryError)) throw promptBlockedError();
        throw geminiApiError("Music generation failed.", retryError);
      }
    }

    // Usually already completed; poll as a safety net if the API ever returns
    // in_progress, so the caller still gets the finished clip in this one request.
    const start = Date.now();
    while (isRunning(interaction) && Date.now() - start < MAX_WAIT_MS) {
      await sleep(POLL_MS);
      try {
        interaction = await client.interactions.get(interaction.id);
      } catch (error) {
        throw geminiApiError("Polling the music interaction failed.", error);
      }
    }

    if (isRunning(interaction)) {
      throw new InferenceProviderError("Music generation is taking too long — try again.", {
        statusCode: 504,
        code: "music_generation_timeout",
        details: { model },
      });
    }

    return completedResult(interaction, generationId, model);
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
      return failedResult(generation.model, "No music interaction to poll.");
    }

    const client = clientFactory(clientConfig.options);
    let interaction: Interaction;
    try {
      interaction = await client.interactions.get(interactionId);
    } catch (error) {
      throw geminiApiError("Polling the music interaction failed.", error);
    }

    if (isRunning(interaction)) {
      return {
        provider: providerID,
        model: generation.model,
        status: "in_progress",
        providerJobId: interactionId,
        providerGenerationId: interactionId,
        providerPollingUrl: interactionId,
        outputs: [],
        metadata: { provider: providerID, api: "interactions", interactionId },
      };
    }
    try {
      return completedResult(interaction, generation.id, generation.model);
    } catch (error) {
      if (error instanceof InferenceProviderError) {
        return failedResult(generation.model, error.message);
      }
      throw error;
    }
  }

  return {
    id: providerID,
    // Music only: advertising the generic "audio" capability would let this be a
    // fallback match for speech routing and misroute voiceovers here.
    capabilities: ["music"],
    configured,
    listModels,
    assetModelFor: (request) =>
      resolveModel(request.model, toJsonObject(request.parameters ?? {})),
    generateAsset,
    refreshAsset,
  };
}

function isRunning(interaction: Interaction): boolean {
  return interaction.status === "in_progress" || interaction.status === "requires_action";
}

// Lyria's policy rejection, by the provider's own error text (a technical field,
// not user input) — a named artist/song/brand, or other blocked content.
function isContentBlock(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /prohibited|sensitive word|content.?block|use policy|rephras|blocked|safety/i.test(message);
}

function promptBlockedError(): InferenceProviderError {
  return new InferenceProviderError(
    "Couldn't generate music for that description — describe the style, instruments, mood, and language instead of naming an artist or song.",
    { statusCode: 400, code: "music_prompt_blocked" },
  );
}

const REWRITE_INSTRUCTION =
  "You rewrite a music generation request so it passes a content policy that blocks " +
  "named artists, bands, songs, albums, and brands. Rewrite it to describe the SOUND " +
  "itself — genre, instrumentation, vocal style and gender, mood, energy, and tempo — " +
  "and keep the language the lyrics should be in and what they should be about. Never " +
  "name any real artist, band, song, album, or brand; translate any such reference into " +
  "its musical characteristics. Reply with ONLY the rewritten prompt, one or two vivid sentences.";

// Ask a fast model to restate a blocked prompt as a policy-safe description of the
// sound. Returns undefined on any failure, so the caller surfaces a clean block
// message rather than retrying with nothing.
async function rewritePrompt(
  client: GeminiMusicClient,
  prompt: string,
): Promise<string | undefined> {
  try {
    const response = await client.models.generateContent({
      model: geminiModels.flash,
      contents: [{ role: "user", parts: [{ text: `${REWRITE_INSTRUCTION}\n\nRequest: ${prompt}` }] }],
    });
    const text = (response as { text?: string }).text?.trim();
    return text && text !== prompt ? text : undefined;
  } catch {
    return undefined;
  }
}

// A completed interaction mapped to a provider result. Throws when the settled
// interaction carries no usable audio, so the route records a failed usage event
// instead of returning an empty success.
function completedResult(
  interaction: Interaction,
  generationId: string,
  model: string,
): AssetGenerationProviderResult {
  const audio = interaction.output_audio;
  if (interaction.status !== "completed" || !audio || (!audio.data && !audio.uri)) {
    throw new InferenceProviderError(
      interactionError(interaction) ?? "Gemini returned no music for this request.",
      {
        statusCode: 502,
        code: "empty_music_generation",
        details: { model, status: interaction.status ?? null },
      },
    );
  }
  const mimeType = audio.mime_type ?? "audio/mp3";
  const output: GenerationOutputRef = {
    id: `${generationId}-music-0`,
    kind: "audio",
    contentType: mimeType,
    filename: `${generationId}-0.${extensionForMime(mimeType)}`,
    metadata: { source: "provider-output" },
    ...(audio.data ? { dataBase64: audio.data } : { url: audio.uri }),
  };
  return {
    provider: providerID,
    model,
    status: "completed",
    // Billed flat per clip at completion (generationCount): a Lyria clip is a
    // fixed-length render, and the interaction carries no per-second usage.
    usage: { generationCount: 1 },
    outputs: [output],
    metadata: { provider: providerID, api: "interactions" },
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

function extensionForMime(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg") || mimeType.includes("opus")) return "ogg";
  return "mp3";
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
