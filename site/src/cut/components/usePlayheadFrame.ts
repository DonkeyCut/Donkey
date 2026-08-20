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

/** The clip's ungraded frame under the playhead, re-sampled as it moves — the
 * base every color preset swatch paints its own recipe onto. */
export function useClipSourceFrame(clipId: string): string | null {
  const [frame, setFrame] = useState<string | null>(null);
  const tick = usePreviewTimeEvery(5);
  const epoch = useEditor((s) => s.loadEpoch);
  useEffect(() => {
    const t = setTimeout(() => {
      const shot = snapshotClipSource(clipId);
      if (shot) setFrame(shot);
    }, 160);
    return () => clearTimeout(t);
  }, [tick, epoch, clipId]);
  return frame;
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
  const [frame, setFrame] = useState<string | null>(() =>
    lastFrame && lastFrame.project === projectId ? lastFrame.url : null
  );
  const tick = usePreviewTimeEvery(5);
  const epoch = useEditor((s) => s.loadEpoch);
  // The tile shows the live frame, which a cut of titles and shapes over the
  // background has as much as one made of footage.
  const hasPicture = useEditor((s) => projectDuration(s) > 0);
  useEffect(() => {
    if (!hasPicture || !projectId) return;
    const t = setTimeout(() => {
      const shot = snapshotPreview();
      if (shot) {
        lastFrame = { project: projectId, url: shot };
        setFrame(shot);
      }
    }, 160);
    return () => clearTimeout(t);
  }, [tick, epoch, hasPicture, projectId]);
  return hasPicture ? frame : null;
}
