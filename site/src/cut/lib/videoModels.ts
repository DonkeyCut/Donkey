// The video-model registry: which models render, and what each supports.
// Pure data + lookups (no store, no browser), so the genvideo self-test can
// exercise everything that reads constraints from here.

import { geminiOmniMaxReferenceImages } from "@/lib/inference/gemini-models";

/** The shape the next generated clip is composed in — landscape or portrait. */
export type VideoAspect = "16:9" | "9:16";

export const VIDEO_ASPECT_LABEL: Record<VideoAspect, string> = {
  "16:9": "Landscape (16:9)",
  "9:16": "Portrait (9:16)",
};

/** A selectable video model. Every render runs on the unified Omni renderer:
 * one pass takes text plus optional seed/reference images and returns the
 * whole clip with audio — the model picks the length (up to ~10s of 720p), so
 * there is no duration or resolution knob. Adding a model here is the whole
 * client-side change. */
export type VideoTier = "omni";

export interface VideoModelOption {
  tier: VideoTier;
  /** Segment label and the model name shown beside it (equal for a
   * single-model entry). */
  word: string;
  model: string;
  /** Identity reference images a render accepts alongside the prompt. */
  maxReferenceImages: number;
  aspects: VideoAspect[];
}

export const VIDEO_MODELS: VideoModelOption[] = [
  {
    tier: "omni",
    word: "Omni Flash",
    model: "Omni Flash",
    maxReferenceImages: geminiOmniMaxReferenceImages,
    aspects: ["16:9", "9:16"],
  },
];

/** The registry entry for a tier — the single source of truth for what that
 * model supports. Any code that generates video (the panel, the scene pipeline)
 * reads its constraints from here, so swapping models is one edit in this file. */
export function videoModel(tier: VideoTier): VideoModelOption {
  return VIDEO_MODELS.find((m) => m.tier === tier) ?? VIDEO_MODELS[0];
}

/** The default model's supported shapes — what AI-path renders and pipeline
 * seeds clamp the project aspect onto when no tier was picked. */
export function defaultVideoAspects(): VideoAspect[] {
  return VIDEO_MODELS[0].aspects;
}
