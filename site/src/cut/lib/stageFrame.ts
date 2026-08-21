"use client";

/**
 * The picture the preview is showing, as a still that goes anywhere.
 *
 * Right-clicking the canvas copies the frame. It is drawn through the render
 * path rather than read back off the preview canvas: elements, captions and
 * effects sit in DOM above that canvas, and a still meant to open a post has
 * to carry them. The PNG lands on the system clipboard for anything that takes
 * an image — a chat composer, a message, another app — and is held here for ⌘V
 * onto the timeline, where it becomes a project image at the preview time.
 *
 * The held frame and the timeline clipboard are one clipboard to the person
 * using them, so a copy on either side clears the other and ⌘V has one answer.
 */

import { renderProjectFrame } from "./exportRender";
import { enrichAsset, uploadProjectImage } from "./media";
import { previewAt } from "./playhead";
import { rasterCanvasToPng } from "./raster";
import { projectDuration, useEditor } from "./store";
import { frameOf, type MediaAsset } from "./types";

/** A copied frame, waiting for a paste. */
interface CopiedFrame {
  png: Blob;
  /** Timeline second it was taken at — it names the asset. */
  at: number;
}

let held: CopiedFrame | null = null;

/** m:ss, for the still's name. */
function stampOf(at: number): string {
  const total = Math.round(at);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Draw the cut as it stands at `at`, at the project's full frame size:
 * clips, transitions, effects, elements, captions, the project fade. */
export async function renderStageFrame(at: number): Promise<Blob> {
  const s = useEditor.getState();
  const frame = frameOf(s.aspect);
  const canvas = await renderProjectFrame(
    {
      aspect: s.aspect,
      assets: s.assets,
      clips: s.clips,
      audioClips: s.audioClips,
      overlays: s.overlays,
      subtitles: s.subtitles,
      fadeIn: s.fadeIn,
      fadeOut: s.fadeOut,
      background: s.background,
    },
    at,
    { width: frame.w, height: frame.h },
    (asset) => asset.url
  );
  return rasterCanvasToPng(canvas);
}

/** Whether the stage has a picture worth copying. */
export const stageHasFrame = (): boolean => projectDuration(useEditor.getState()) > 0;

/**
 * Copy the frame the preview is showing.
 *
 * The blob goes onto the system clipboard as a promise rather than an awaited
 * value: Safari ties a clipboard write to the gesture that asked for it, and
 * compositing the frame first spends that gesture. Rejects when the frame
 * cannot be drawn or the browser refuses the write, which is the caller's cue
 * to say so — a frame that drew is held for the timeline either way.
 */
export async function copyStageFrame(): Promise<void> {
  const at = Math.max(0, previewAt());
  const png = renderStageFrame(at);
  // The write's verdict is kept rather than awaited here: a frame that fails
  // to draw fails the write with it, and the draw is the failure worth
  // reporting. A browser that refuses the call on the spot — no clipboard on
  // an insecure context, a ClipboardItem that wants a settled blob — throws
  // where it stands, so it is caught into the same verdict and the frame
  // below is still held for ⌘V.
  let wroteOk: Promise<boolean>;
  try {
    wroteOk = navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(
      () => true,
      () => false
    );
  } catch {
    wroteOk = Promise.resolve(false);
  }
  held = { png: await png, at };
  // The frame is the clipboard's contents now; a timeline copy no longer
  // outranks it at the next ⌘V.
  useEditor.getState().clearClipboard();
  if (!(await wroteOk)) throw new Error("The browser refused the clipboard write.");
}

/** Whether a copied frame is waiting for ⌘V. */
export const hasCopiedFrame = (): boolean => held !== null;

/** Forget the copied frame — a ⌘C on the timeline is the newer copy. */
export const clearCopiedFrame = (): void => {
  held = null;
};

/** Store a composited still as a project image, named for the moment it was
 * taken. Created media, so it carries the freeze origin and stays out of the
 * Media panel. */
export async function storeStageStill(
  projectId: string,
  png: Blob,
  at: number,
  failMessage?: string
): Promise<MediaAsset> {
  const stamp = stampOf(at);
  const fileName = `frame-${stamp.replace(":", "m")}s-${crypto.randomUUID().slice(0, 4)}.png`;
  const body = await uploadProjectImage(projectId, png, fileName, {
    name: `Frame ${stamp}`,
    ...(failMessage ? { failMessage } : {}),
  });
  return { ...body, origin: "freeze" };
}

/**
 * Land the copied frame on the timeline: a project image placed at the preview
 * time on the first row with room for it.
 */
export async function pasteCopiedFrame(): Promise<void> {
  const frame = held;
  const s = useEditor.getState();
  if (!frame || !s.projectId || s.readOnly) return;
  const projectId = s.projectId;
  const asset = await storeStageStill(projectId, frame.png, frame.at, "Could not paste the frame.");
  const cur = useEditor.getState();
  // The project can change while the upload runs; the still belongs to the one
  // it was pasted into.
  if (cur.projectId !== projectId) return;
  cur.addAsset(asset);
  cur.addAssetAtPlayhead(asset.id);
  void enrichAsset(asset);
}
