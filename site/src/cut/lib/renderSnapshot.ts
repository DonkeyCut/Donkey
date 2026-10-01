import type { OutputSpace } from "@donkeycut/effects-kit";
import type { Aspect, MediaAsset, VideoClip, AudioClip, Overlay, SubtitlesBlock, TimelineBody, TimelineId } from "@/cut/lib/types";
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
  /** The delivery's color space; absent = SDR. */
  colorSpace?: OutputSpace;
  /** Which timeline the cut above is (absent = main), and the parked ones: a
   * share render reads them when the link plays another timeline. */
  timeline?: TimelineId;
  timelines?: Partial<Record<TimelineId, TimelineBody>>;
};

export type RenderSnapshot = {
  operation: ProjectOperation;
  revision: string;
  doc: ExportDoc;
};

/** Called when work is submitted, outside playback and store subscriptions. */
export function captureRenderSnapshot(operation: ProjectOperation, doc: ExportDoc): RenderSnapshot {
  // The parked timelines ride by reference: the store replaces them whole and
  // never edits one in place, and copying them would cost every render the
  // size of timelines nothing on screen draws.
  const { timelines, ...cut } = doc;
  return { operation, revision: crypto.randomUUID(), doc: { ...structuredClone(cut), ...(timelines ? { timelines } : {}) } };
}

export function renderDoc(doc: ExportDoc): ExportDoc {
  return {
    aspect: doc.aspect, assets: doc.assets, clips: doc.clips, audioClips: doc.audioClips,
    overlays: doc.overlays, subtitles: doc.subtitles, background: doc.background,
    ...(doc.colorSpace ? { colorSpace: doc.colorSpace } : {}),
    ...(doc.timelines && Object.keys(doc.timelines).length > 0 ? { timeline: doc.timeline, timelines: doc.timelines } : {}),
  };
}
