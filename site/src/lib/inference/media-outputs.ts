import type {
  AssetGenerationKind,
  GenerationOutputRef,
  InferenceModality,
  JsonValue,
} from "@/lib/inference/providers";
import { isJsonObject } from "@/lib/inference/json";

const extensionByKind: Record<AssetGenerationKind, RegExp> = {
  image: /\.(png|jpe?g|webp|gif|heic|avif)(\?|#|$)/i,
  video: /\.(mp4|webm|mov|m4v)(\?|#|$)/i,
  matte: /\.(mp4|webm|mov|m4v)(\?|#|$)/i,
  music: /\.(mp3|wav|m4a|aac|ogg|flac)(\?|#|$)/i,
  speech: /\.(mp3|wav|m4a|aac|ogg|flac|pcm)(\?|#|$)/i,
};

const contentTypeByKind: Record<AssetGenerationKind, string> = {
  image: "image/png",
  video: "video/mp4",
  matte: "video/mp4",
  music: "audio/mpeg",
  speech: "audio/mpeg",
};

export function mediaKind(kind: AssetGenerationKind): InferenceModality {
  if (kind === "music" || kind === "speech") return "audio";
  return kind === "matte" ? "video" : kind;
}

export function extractMediaOutputs(
  value: JsonValue,
  kind: AssetGenerationKind,
): GenerationOutputRef[] {
  const urls = new Set<string>();
  collectUrls(value, kind, urls);

  return Array.from(urls).map((url, index) => ({
    id: `${mediaKind(kind)}-${index + 1}`,
    kind: mediaKind(kind),
    url,
    contentType: contentTypeByKind[kind],
    metadata: {
      source: "provider-output",
    },
  }));
}

function collectUrls(value: JsonValue, kind: AssetGenerationKind, urls: Set<string>) {
  if (typeof value === "string") {
    if (looksLikeMediaURL(value, kind)) {
      urls.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrls(item, kind, urls);
    }
    return;
  }

  if (!isJsonObject(value)) {
    return;
  }

  const imageURL = readNestedURL(value, "image_url");
  if (kind === "image" && imageURL) {
    urls.add(imageURL);
  }

  const audioURL = readNestedURL(value, "audio_url");
  if (kind === "music" && audioURL) {
    urls.add(audioURL);
  }

  const videoURL = readNestedURL(value, "video_url");
  if (kind === "video" && videoURL) {
    urls.add(videoURL);
  }

  for (const child of Object.values(value)) {
    collectUrls(child, kind, urls);
  }
}

function readNestedURL(value: Record<string, JsonValue>, key: string) {
  const nested = value[key];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    return null;
  }

  const url = nested.url;
  return typeof url === "string" ? url : null;
}

function looksLikeMediaURL(value: string, kind: AssetGenerationKind) {
  if (value.startsWith(`data:${contentTypeByKind[kind]}`)) {
    return true;
  }

  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    return false;
  }

  return extensionByKind[kind].test(value);
}
