"use client";

import { useEffect, useState } from "react";
import { getPreviewCanvas, sampleClipSource } from "@/cut/lib/previewCanvas";
import { projectDuration, useEditor } from "@/cut/lib/store";
import { usePreviewTimeEvery } from "@/cut/lib/playhead";

/** The sampled preview frame's short side, doubled from the tile swatch's
 * on-screen size so it stays sharp on retina displays. */
export const FRAME_SHORT = 360;

/** A snapshot of the live preview canvas — the whole frame under the playhead,
 * at the canvas's own aspect — encoded small for the tile swatches; null when
 * the canvas has no picture yet. */
export function snapshotPreview(): string | null {
  const src = getPreviewCanvas();
  if (!src || !src.width || !src.height) return null;
  const scale = FRAME_SHORT / Math.min(src.width, src.height);
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(src, 0, 0, c.width, c.height);
    // The engine leaves the canvas untouched until a decoder has a frame; a
    // fully transparent readback means there is no picture to show yet.
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = false;
    for (let i = 3; i < px.length; i += 397 * 4) {
      if (px[i] > 0) {
        lit = true;
        break;
      }
    }
    if (!lit) return null;
    return c.toDataURL("image/jpeg", 0.72);
  } catch {
    // A tainted canvas or a blocked readback: the swatch keeps its stand-in.
    return null;
  }
}

/** The natural size of whatever the decoder handed over — a video frame, an
 * image bitmap, or a canvas. */
function sourceSize(src: CanvasImageSource): { w: number; h: number } | null {
  const s = src as {
    displayWidth?: number;
    displayHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number | SVGAnimatedLength;
    height?: number | SVGAnimatedLength;
  };
  const plain = (v: number | SVGAnimatedLength | undefined) => (typeof v === "number" ? v : 0);
  const w = s.displayWidth || s.videoWidth || s.naturalWidth || plain(s.width);
  const h = s.displayHeight || s.videoHeight || s.naturalHeight || plain(s.height);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** A clip's own decoded frame, before any grade, encoded small. The composited
 * preview carries the clip's grade already, so a preset swatch drawn from it
 * would fold that grade in twice. */
export function snapshotClipSource(clipId: string): string | null {
  const src = sampleClipSource(clipId);
  const size = src && sourceSize(src);
  if (!src || !size) return null;
  const scale = Math.min(1, FRAME_SHORT / Math.min(size.w, size.h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(size.w * scale));
  c.height = Math.max(1, Math.round(size.h * scale));
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

/** Sampling beats per second while the playhead is being moved by hand. */
const SCRUB_BEATS = 5;
/** Beats folded into one sample while playback runs: the swatches want
 * variety, and once a second is variety enough. */
const PLAY_BEAT = 5;

/**
 * The swatch feed's shared schedule and hand-off. Playing publishes about
 * once a second; paused publishes on every move, so the tiles land on the
 * exact frame under the playhead — including the frame playback stops on,
 * which gets its own sample when `playing` flips. Every URL is decoded before
 * it publishes: an <img> handed an undecoded one paints blank for a beat,
 * which is what made the swatches flicker.
 */
function useSampledFrame(
  snapshot: () => string | null,
  enabled: boolean,
  key: unknown,
  initial: string | null = null,
  onShot?: (url: string) => void
): string | null {
  const [frame, setFrame] = useState<string | null>(initial);
  const playing = useEditor((s) => s.playing);
  const tick = usePreviewTimeEvery(SCRUB_BEATS);
  const epoch = useEditor((s) => s.loadEpoch);
  const beat = playing ? Math.floor(tick / PLAY_BEAT) : tick;
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    // A beat after the move, so the decoder has painted the frame.
    const t = setTimeout(() => {
      const shot = snapshot();
      if (!shot) return;
      const img = new Image();
      img.src = shot;
      const land = () => {
        if (gone) return;
        onShot?.(shot);
        setFrame(shot);
      };
      img.decode().then(land, land);
    }, 160);
    return () => {
      gone = true;
      clearTimeout(t);
    };
    // snapshot and onShot read live state; the beat is the schedule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat, playing, epoch, enabled, key]);
  return frame;
}

/** The clip's ungraded frame under the playhead, re-sampled as it moves — the
 * base every color preset swatch paints its own recipe onto. */
export function useClipSourceFrame(clipId: string): string | null {
  return useSampledFrame(() => snapshotClipSource(clipId), true, clipId);
}

/** The last sampled frame, kept across tab switches: a panel unmounts when
 * another tab opens, and a fresh mount seeds from here so the tiles paint the
 * real picture at once with no pass through the stand-in. */
let lastFrame: { project: string; url: string } | null = null;

/** The frame under the playhead as a small data URL, re-sampled as the
 * playhead moves (about five times a second, a beat after each move so the
 * decoder has painted); null until the preview has a picture. */
export function usePlayheadFrame(): string | null {
  const projectId = useEditor((s) => s.projectId);
  // The tile shows the live frame, which a cut of titles and shapes over the
  // background has as much as one made of footage.
  const hasPicture = useEditor((s) => projectDuration(s) > 0);
  const frame = useSampledFrame(
    snapshotPreview,
    hasPicture && !!projectId,
    projectId,
    lastFrame && lastFrame.project === projectId ? lastFrame.url : null,
    (url) => {
      if (projectId) lastFrame = { project: projectId, url };
    }
  );
  return hasPicture ? frame : null;
}
