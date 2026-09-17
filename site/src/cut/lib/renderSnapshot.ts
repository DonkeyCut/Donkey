import type { Aspect, MediaAsset, VideoClip, AudioClip, Overlay, SubtitlesBlock } from "@/cut/lib/types";
import type { ProjectOperation } from "@/cut/lib/projectOperation";

export type ExportDoc = {
  /** Output frame ratio the cut renders at — keeps burn-in layout (caption
   * wrap) in the same design space as the live preview. */
  aspect: Aspect;
  assets: MediaAsset[];
  /** Every video clip, any track (track 0 folds sequentially, others composite). */
  clips: VideoClip[];
  audioClips: AudioClip[];
  overlays: Overlay[];
  subtitles: SubtitlesBlock;
  /** The frame's own color behind every clip and element (hex); absent = black. */
  background?: string;
};

export type RenderSnapshot = {
  operation: ProjectOperation;
  revision: string;
  doc: ExportDoc;
};

/** Called when work is submitted, outside playback and store subscriptions. */
export function captureRenderSnapshot(operation: ProjectOperation, doc: ExportDoc): RenderSnapshot {
  return { operation, revision: crypto.randomUUID(), doc: structuredClone(doc) };
}

export function renderDoc(doc: ExportDoc): ExportDoc {
  return {
    aspect: doc.aspect, assets: doc.assets, clips: doc.clips, audioClips: doc.audioClips,
    overlays: doc.overlays, subtitles: doc.subtitles, background: doc.background,
  };
}
