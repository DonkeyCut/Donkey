import type { MediaAsset, VideoClip } from "./types";

/** A template's footage slots: every clip playing a video or a still, in the
 * order they play, the lower track first where two start together. A
 * person's clips fill them in this order. */
export function footageSlots(clips: VideoClip[], assets: Pick<MediaAsset, "id" | "type">[]): VideoClip[] {
  const types = new Map(assets.map((a) => [a.id, a.type]));
  return clips
    .filter((c) => {
      const type = types.get(c.assetId);
      return type === "video" || type === "image";
    })
    .sort((a, b) => a.start - b.start || a.track - b.track);
}
