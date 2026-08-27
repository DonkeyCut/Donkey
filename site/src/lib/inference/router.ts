import { createGeminiResponsesProvider } from "@/lib/inference/adapters/gemini-responses";
import { createGeminiImageAssetProvider } from "@/lib/inference/adapters/gemini-image";
import { createGeminiMusicAssetProvider } from "@/lib/inference/adapters/gemini-music";
import { createGeminiSpeechAssetProvider } from "@/lib/inference/adapters/gemini-speech";
import { createGeminiOmniVideoAssetProvider } from "@/lib/inference/adapters/gemini-omni-video";
import { createFalMatteProvider } from "@/lib/inference/adapters/fal-matte";
import {
  InferenceProviderError,
  type AssetGenerationRequest,
  type InferenceModality,
  type InferenceModel,
  type InferenceProvider,
  type JsonValue,
  type ResponseCreateRequest,
  type StoredGenerationForProvider,
} from "@/lib/inference/providers";

// Input part types that carry audio/video media. Only a provider that declares handlesResponseMedia
// can render these, so the router uses this to route media requests by capability.
const mediaPartTypes = new Set(["input_audio", "input_video", "audio", "video"]);

function responseRequestHasMedia(request: ResponseCreateRequest): boolean {
  const search = (value: JsonValue | undefined): boolean => {
    if (Array.isArray(value)) {
      return value.some(search);
    }
    if (value && typeof value === "object") {
      const type = (value as Record<string, JsonValue>).type;
      if (typeof type === "string" && mediaPartTypes.has(type)) {
        return true;
      }
      return Object.values(value as Record<string, JsonValue>).some(search);
    }
    return false;
  };
  return search(request.body.input as JsonValue | undefined);
}

export class ProviderRegistry {
  private providers: InferenceProvider[];

  public constructor(providers: InferenceProvider[]) {
    this.providers = providers;
  }

  public async listModels(modalities: InferenceModality[]) {
    const configuredProviders = this.providers.filter((provider) => provider.configured);
    if (configuredProviders.length === 0) {
      throw new InferenceProviderError("No configured inference provider is available.", {
        statusCode: 503,
        code: "no_inference_provider",
      });
    }

    // One provider failing to enumerate its models (e.g. an API key missing a list permission)
    // must not take down the combined catalog — skip it and keep the models from the rest.
    const results: InferenceModel[] = [];
    for (const provider of configuredProviders) {
      results.push(...(await provider.listModels(modalities)));
    }

    return dedupeModels(results);
  }

  public textProvider(stream: boolean) {
    const provider = this.providers.find((candidate) => {
      return candidate.configured && (stream ? candidate.streamCompletion : candidate.completeText);
    });

    if (!provider) {
      throw new InferenceProviderError("No configured text inference provider is available.", {
        statusCode: 503,
        code: "no_text_provider",
      });
    }

    return provider;
  }

  public responsesProvider(request?: ResponseCreateRequest) {
    if (request?.donkeyProvider) {
      const provider = this.providers.find((candidate) => {
        return (
          Boolean(candidate.createResponse) &&
          Boolean(candidate.responseProviderIDs?.includes(request.donkeyProvider ?? "")) &&
          candidate.canCreateResponse?.(request) !== false
        );
      });

      if (!provider) {
        throw new InferenceProviderError("Requested Responses provider is unavailable.", {
          statusCode: 404,
          code: "provider_not_found",
          details: { provider: request.donkeyProvider },
        });
      }

      if (!provider.configured) {
        throw new InferenceProviderError("Requested Responses provider is not configured.", {
          statusCode: 503,
          code: "missing_provider_credentials",
          details: { provider: request.donkeyProvider },
        });
      }

      return provider;
    }

    const mediaRequest = request ? responseRequestHasMedia(request) : false;
    const provider = this.providers.find((candidate) => {
      return (
        candidate.configured &&
        Boolean(candidate.createResponse) &&
        (request ? candidate.canCreateResponse?.(request) !== false : true) &&
        // A request with audio/video parts must go to a provider that positively handles media,
        // so it is never routed to one (current or future) that would silently drop the media.
        (mediaRequest && request ? candidate.handlesResponseMedia?.(request) === true : true)
      );
    });

    if (!provider) {
      if (mediaRequest) {
        throw new InferenceProviderError(
          "No configured Responses provider can handle audio/video input.",
          { statusCode: 415, code: "no_media_responses_provider" },
        );
      }
      throw new InferenceProviderError("No configured Responses provider is available.", {
        statusCode: 503,
        code: "no_responses_provider",
      });
    }

    return provider;
  }

  public assetProvider(request: AssetGenerationRequest) {
    if (request.provider) {
      const provider = this.providers.find((candidate) => candidate.id === request.provider);
      if (!provider || !provider.generateAsset) {
        throw new InferenceProviderError("Requested inference provider is unavailable.", {
          statusCode: 404,
          code: "provider_not_found",
        });
      }

      if (!provider.configured) {
        throw new InferenceProviderError("Requested inference provider is not configured.", {
          statusCode: 503,
          code: "missing_provider_credentials",
        });
      }

      return provider;
    }

    const preferredCapabilities =
      request.kind === "music"
        ? ["music", "audio"]
        : request.kind === "speech"
          ? ["speech", "audio"]
          : [request.kind];

    const provider = this.providers.find((candidate) => {
      return (
        candidate.configured &&
        Boolean(candidate.generateAsset) &&
        preferredCapabilities.some((capability) => {
          return candidate.capabilities.includes(capability as InferenceModality);
        })
      );
    });

    if (!provider) {
      throw new InferenceProviderError("No configured asset generation provider is available.", {
        statusCode: 503,
        code: "no_asset_provider",
      });
    }

    return provider;
  }

  public providerForGeneration(generation: StoredGenerationForProvider) {
    const provider = this.providers.find((candidate) => candidate.id === generation.provider);
    if (!provider) {
      throw new InferenceProviderError("Generation provider is unavailable.", {
        statusCode: 404,
        code: "provider_not_found",
      });
    }

    if (!provider.configured) {
      throw new InferenceProviderError("Generation provider is not configured.", {
        statusCode: 503,
        code: "missing_provider_credentials",
      });
    }

    return provider;
  }

  public async refresh(generation: StoredGenerationForProvider) {
    const provider = this.providerForGeneration(generation);
    if (!provider.refreshAsset) {
      throw new InferenceProviderError("Generation provider cannot refresh assets.", {
        statusCode: 400,
        code: "refresh_not_supported",
      });
    }

    return provider.refreshAsset(generation);
  }
}

export function createProviderRegistry() {
  return new ProviderRegistry([
    // Asset selection is by capability + generateAsset, not list order: the image asset
    // provider serves kind="image" (gemini-responses lists "image" as an input modality
    // but has no generateAsset, so it is never chosen for asset generation).
    createGeminiImageAssetProvider(),
    // Omni (Gemini Omni Flash) serves kind="video"; its distinct provider id
    // keeps async refresh routing from colliding with the synchronous image
    // adapter.
    createGeminiOmniVideoAssetProvider(),
    // Gemini TTS serves kind="speech" (voiceovers, subtitle read-alouds).
    createGeminiSpeechAssetProvider(),
    // Gemini/Lyria is the sole kind="music" provider — the Audio-tab generator,
    // generate_music, and the brief-to-video bed. It runs on the always-hosted
    // Vertex service account, so music never falls back to another provider. The
    // adapter picks the clip or the longer pro model from the requested length so
    // a bed can still span a longer video (see gemini-music.ts).
    createGeminiMusicAssetProvider(),
    // The matte segmenter serves kind="matte": Cut's background-removal
    // quality bake, a clip segment plus a text description and/or point
    // prompts in, a mask video out.
    createFalMatteProvider(),
    createGeminiResponsesProvider(),
  ]);
}

function dedupeModels(models: InferenceModel[]) {
  const seen = new Set<string>();
  const result: InferenceModel[] = [];
  for (const model of models) {
    const key = `${model.provider}:${model.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(model);
  }

  return result;
}
