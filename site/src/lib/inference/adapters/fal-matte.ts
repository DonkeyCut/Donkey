import { ALL_FORMATS, Input, UrlSource } from "mediabunny";

import { providerCreditPricing } from "@/lib/credits/provider-pricing";
import { falMatteModels, type FalMatteModel } from "@/lib/inference/matte-models";
import { matteConceptPrompt, mattePointPrompts } from "@/lib/inference/matte-prompts";
import { ensureConfigured } from "@/lib/inference/http";
import { isJsonObject, toJsonObject } from "@/lib/inference/json";
import {
  InferenceProviderError,
  type AssetGenerationProviderRequest,
  type AssetGenerationProviderResult,
  type InferenceModality,
  type InferenceModel,
  type InferenceProvider,
  type JsonValue,
  type StoredGenerationForProvider,
} from "@/lib/inference/providers";

// The matte provider: queue-hosted matting for kind="matte", one model per
// job. The segmenter takes a clip segment (by URL — the route resolves the
// caller's stored blob into a read link) plus a text description of what to
// keep, click prompts, or both together — points sharing an object id refine
// what the words detected — and returns a mask video. The removal model
// takes only the segment and masks the foreground subject whole, returning
// the mask as a grayscale "alpha" h264 video. Predictions are async: submit
// here, poll through refresh; the charge bills at submit, counted in each
// model's own unit.
const providerID = "fal";

const QUEUE_BASE = "https://queue.fal.run";

// Each model meters per processed-frame chunk of its own size, so the charge
// counts the same unit: the submitted segment is probed for its frame count
// and each started chunk bills one generation at the model's per-chunk price.
const matteChunkFrames: Record<FalMatteModel, number> = {
  [falMatteModels.segmenter]: 16,
  [falMatteModels.removal]: 30,
};

// The billable chunk count of the segment at `videoUrl` — the server's own
// count, so the charge never rides a client-supplied number. The frame count
// is the track's duration times its packet rate, both read from the
// container's metadata: a bounded sample of packet headers settles the rate
// (segments encode at one constant rate), and no media bytes download on the
// billing path. An unreadable segment stops the submit.
const RATE_SAMPLE_PACKETS = 100;

async function billableChunks(videoUrl: string, chunkFrames: number): Promise<number> {
  const input = new Input({ source: new UrlSource(videoUrl), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track) {
      const duration = await track.computeDuration();
      const rate = (await track.computePacketStats(RATE_SAMPLE_PACKETS)).averagePacketRate;
      const frames = Math.round(duration * rate);
      if (frames > 0) {
        return Math.ceil(frames / chunkFrames);
      }
    }
  } catch {
    // Falls through to the one error shape below.
  } finally {
    input.dispose();
  }
  throw new InferenceProviderError("The clip segment could not be read for billing.", {
    statusCode: 422,
    code: "matte_segment_unreadable",
  });
}

export type AdapterEnvironment = Record<string, string | undefined>;
export type MatteFetch = typeof fetch;

export function createFalMatteProvider(
  environment: AdapterEnvironment = process.env,
  fetchImpl: MatteFetch = fetch,
): InferenceProvider {
  const token = environment.FAL_KEY?.trim();
  const configured = Boolean(token);
  const defaultModel: FalMatteModel = falMatteModels.segmenter;
  const matteModels = Object.values(falMatteModels) as string[];

  async function listModels(modalities: InferenceModality[]): Promise<InferenceModel[]> {
    if (!modalities.includes("matte")) {
      return [];
    }
    return matteModels.map((id) => ({
      id,
      name: id,
      provider: providerID,
      inputModalities: ["video"],
      outputModalities: ["video"],
      contextLength: null,
      pricing: null,
      metadata: { provider: providerID },
    }));
  }

  function resolveModel(requested?: string): FalMatteModel {
    const model = requested?.trim() || defaultModel;
    if (!matteModels.includes(model)) {
      throw new InferenceProviderError("Unknown matte model.", {
        statusCode: 400,
        code: "unknown_matte_model",
        details: { model },
      });
    }
    // Fail before spending: the resolved model must have a configured price.
    if (!providerCreditPricing(providerID, model)) {
      throw new InferenceProviderError(
        "No credit price is configured for the selected matte model.",
        { statusCode: 500, code: "matte_model_not_priced", details: { model } },
      );
    }
    return model as FalMatteModel;
  }

  // The key goes to the queue host and nowhere else. A poll URL arrives on
  // the refresh request as a client field, so the address is checked here,
  // at the one place the key is attached, and an address off the queue is
  // refused before any request goes out.
  async function api(url: string, init?: RequestInit): Promise<JsonValue> {
    if (new URL(url).origin !== new URL(QUEUE_BASE).origin) {
      throw new InferenceProviderError("The matte poll address is off the queue host.", {
        statusCode: 400,
        code: "matte_poll_url_rejected",
      });
    }
    const res = await fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Key ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => null)) as JsonValue;
    if (!res.ok) {
      const detail =
        isJsonObject(body) && typeof body.detail === "string" ? body.detail : undefined;
      throw new InferenceProviderError(detail ?? "The matte service refused the request.", {
        statusCode: res.status === 429 ? 429 : 502,
        code: "matte_provider_error",
      });
    }
    return body;
  }

  function segmentUrl(request: AssetGenerationProviderRequest["request"]): string {
    const inputs = toJsonObject(request.inputs ?? {});
    const video = isJsonObject(inputs.video) ? inputs.video : {};
    const videoUrl = typeof video.url === "string" ? video.url : "";
    if (!videoUrl) {
      throw new InferenceProviderError("A matte needs the clip segment to track.", {
        statusCode: 400,
        code: "empty_matte_request",
      });
    }
    return videoUrl;
  }

  // The route's pre-preflight count: the chunks this segment will bill, read
  // from the resolved segment itself in the resolved model's own unit. The
  // count needs the media, so this is the provider that pulls the resolver.
  async function assetGenerationCountFor(
    request: AssetGenerationProviderRequest["request"],
    resolveInputs: () => Promise<AssetGenerationProviderRequest["request"]>,
  ): Promise<number> {
    ensureConfigured(configured);
    if (request.kind !== "matte") {
      throw new InferenceProviderError("Provider does not support this asset kind.", {
        statusCode: 400,
        code: "unsupported_asset_kind",
      });
    }
    const resolved = await resolveInputs();
    return billableChunks(segmentUrl(resolved), matteChunkFrames[resolveModel(resolved.model)]);
  }

  async function generateAsset({
    request,
    generationCount,
  }: AssetGenerationProviderRequest): Promise<AssetGenerationProviderResult> {
    ensureConfigured(configured);
    if (request.kind !== "matte") {
      throw new InferenceProviderError("Provider does not support this asset kind.", {
        statusCode: 400,
        code: "unsupported_asset_kind",
      });
    }
    // The route settles the count through assetGenerationCountFor and the
    // preflight holds the balance to it; a submit without one would bill a
    // charge no preflight covered.
    const chunks = Math.floor(generationCount ?? 0);
    if (chunks < 1) {
      throw new InferenceProviderError("The matte charge was not counted before submit.", {
        statusCode: 500,
        code: "matte_charge_uncounted",
      });
    }

    const model = resolveModel(request.model);
    const videoUrl = segmentUrl(request);
    const parameters = toJsonObject(request.parameters ?? {});
    const prompt = matteConceptPrompt(parameters.prompt);
    const points = mattePointPrompts(parameters.points);

    let body: Record<string, unknown>;
    if (model === falMatteModels.removal) {
      // The removal model finds the foreground subject on its own; prompts
      // have nowhere to land, so a prompted request is a caller bug.
      if (prompt || points.length > 0) {
        throw new InferenceProviderError("The removal model takes no selection prompts.", {
          statusCode: 400,
          code: "matte_prompts_unsupported",
        });
      }
      body = {
        video_url: videoUrl,
        // h264 returns the mask alone as a grayscale "alpha" video — the
        // matte contract's shape; vp9 would fold it into an alpha channel
        // WebCodecs cannot read back.
        output_codec: "h264",
        refine_foreground_edges: true,
        subject_is_person: true,
      };
    } else {
      if (!prompt && points.length === 0) {
        throw new InferenceProviderError("A matte needs a text prompt or point prompts.", {
          statusCode: 400,
          code: "empty_matte_prompts",
        });
      }
      // The segmenter takes object ids as integers; each named brush object
      // maps to a stable one in prompt order.
      const objectIds = new Map<string, number>();
      const objectId = (name: string) => {
        const held = objectIds.get(name);
        if (held !== undefined) return held;
        const next = objectIds.size + 1;
        objectIds.set(name, next);
        return next;
      };
      body = {
        video_url: videoUrl,
        // The mask video, without the source picture under it.
        apply_mask: false,
        ...(prompt ? { prompt } : {}),
        ...(points.length > 0
          ? {
              point_prompts: points.map((p) => ({
                x: Math.round(p.x),
                y: Math.round(p.y),
                label: p.label,
                object_id: objectId(p.object),
                frame_index: Math.max(0, Math.round(p.frame)),
              })),
            }
          : {}),
      };
    }

    const submitted = await api(`${QUEUE_BASE}/${model}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const requestId =
      isJsonObject(submitted) && typeof submitted.request_id === "string"
        ? submitted.request_id
        : "";
    const responseUrl =
      isJsonObject(submitted) && typeof submitted.response_url === "string"
        ? submitted.response_url
        : "";
    if (!requestId || !responseUrl) {
      return failedResult(model, "The matte service accepted nothing.");
    }
    // The track is committed, so the frame-counted charge bills now — one
    // generation per 16-frame chunk; the polls that follow are free.
    return {
      ...inProgressResult(requestId, responseUrl, model),
      usage: { generationCount: chunks },
    };
  }

  async function refreshAsset(
    generation: StoredGenerationForProvider,
  ): Promise<AssetGenerationProviderResult> {
    ensureConfigured(configured);
    const responseUrl = generation.providerPollingUrl?.trim() ?? "";
    const requestId = generation.providerJobId?.trim() || generation.providerGenerationId?.trim();
    if (!responseUrl || !requestId) {
      return failedResult(generation.model, "No matte prediction to poll.");
    }
    const status = await api(`${responseUrl}/status`);
    const state =
      isJsonObject(status) && typeof status.status === "string" ? status.status : "";
    if (state === "IN_QUEUE" || state === "IN_PROGRESS") {
      return inProgressResult(requestId, responseUrl, generation.model);
    }
    let result: JsonValue;
    try {
      result = await api(responseUrl);
    } catch (error) {
      const message =
        error instanceof InferenceProviderError ? error.message : "The matte track failed.";
      return failedResult(generation.model, message);
    }
    const url = maskUrl(result);
    if (!url) {
      return failedResult(generation.model, "The tracker returned no mask.");
    }
    return {
      provider: providerID,
      model: generation.model,
      status: "completed",
      outputs: [
        {
          id: `${generation.id}-matte-0`,
          kind: "video",
          contentType: "video/mp4",
          filename: `${generation.id}-matte.mp4`,
          url,
          metadata: { source: "provider-output" },
        },
      ],
      metadata: { provider: providerID },
    };
  }

  function inProgressResult(
    requestId: string,
    responseUrl: string,
    model: string,
  ): AssetGenerationProviderResult {
    return {
      provider: providerID,
      model,
      status: "in_progress",
      providerJobId: requestId,
      providerGenerationId: requestId,
      providerPollingUrl: responseUrl,
      outputs: [],
      metadata: { provider: providerID },
    };
  }

  function failedResult(model: string, message: string): AssetGenerationProviderResult {
    return {
      provider: providerID,
      model,
      status: "failed",
      outputs: [],
      error: { message },
      metadata: { provider: providerID },
    };
  }

  return {
    id: providerID,
    configured,
    capabilities: ["matte"],
    listModels,
    assetModelFor: (request) => resolveModel(request.model),
    assetGenerationCountFor,
    generateAsset,
    refreshAsset,
  };
}

// The finished run's mask video URL. The segmenter returns one video object;
// the removal model returns a file list where the mask is the entry named
// "alpha" (verified against the live endpoint — h264 returns the alpha video
// alone, at the segment's own size and rate).
function maskUrl(result: JsonValue): string | null {
  if (!isJsonObject(result)) {
    return null;
  }
  const video = result.video;
  if (isJsonObject(video) && typeof video.url === "string" && video.url.startsWith("https://")) {
    return video.url;
  }
  if (Array.isArray(video)) {
    const files = video.filter(
      (f): f is { url: string; file_name?: string } =>
        isJsonObject(f) && typeof f.url === "string" && f.url.startsWith("https://"),
    );
    const alpha = files.find((f) =>
      `${typeof f.file_name === "string" ? f.file_name : ""} ${f.url}`.toLowerCase().includes("alpha"),
    );
    if (alpha) return alpha.url;
    if (files.length === 1) return files[0].url;
  }
  return null;
}
