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
 * Drawing it costs a decode of the footage under the playhead, so the draw
 * starts when the menu opens, not when the item is clicked: by the time the
 * pointer reaches "Copy frame" the picture is usually in hand, and the copy
 * reads as instant. The hold is a promise, so a ⌘V that beats the draw still
 * lands the frame it was promised.
 *
 * The held frame and the timeline clipboard are one clipboard to the person
 * using them, so a copy on either side clears the other and ⌘V has one answer.
 */

import { renderProjectFrame } from "./exportRender";
import { uploadProjectImage } from "./media";
import { previewAt } from "./playhead";
import { rasterCanvasToPng } from "./raster";
import { projectDuration, useEditor } from "./store";
import { frameOf, type MediaAsset } from "./types";

/** A frame being drawn, or drawn already. */
interface StageFrame {
  png: Promise<Blob>;
  /** Timeline second it was taken at — it names the still. */
  at: number;
}

let held: StageFrame | null = null;
let primed: StageFrame | null = null;

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

/** The frame at the preview time, drawn once and kept: the canvas menu primes
 * it as it opens so the copy behind it has nothing left to wait for. A failure
 * is carried on the promise and reported when a copy asks for it. */
export function primeStageFrame(): void {
  const at = Math.max(0, previewAt());
  if (primed?.at === at) return;
  const png = renderStageFrame(at);
  void png.catch(() => {});
  primed = { png, at };
}

/**
 * Copy the frame the preview is showing.
 *
 * The blob goes onto the system clipboard as a promise rather than an awaited
 * value: Safari ties a clipboard write to the gesture that asked for it, and
 * compositing the frame first spends that gesture. The frame is held for ⌘V
 * before either settles, so a paste right behind the click has it. Rejects
 * when the frame cannot be drawn or the browser refuses the write, which is
 * the caller's cue to say so — a frame that drew is held for the timeline
 * either way.
 */
export async function copyStageFrame(): Promise<void> {
  const at = Math.max(0, previewAt());
  const png = primed?.at === at ? primed.png : renderStageFrame(at);
  primed = null;
  held = { png, at };
  // The write's verdict is kept rather than awaited here: a frame that fails
  // to draw fails the write with it, and the draw is the failure worth
  // reporting. A browser that refuses the call on the spot — no clipboard on
  // an insecure context, a ClipboardItem that wants a settled blob — throws
  // where it stands, so it is caught into the same verdict.
  let wroteOk: Promise<boolean>;
  try {
    wroteOk = navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(
      () => true,
      () => false
    );
  } catch {
    wroteOk = Promise.resolve(false);
  }
  try {
    await png;
  } catch (err) {
    // Nothing was drawn, so there is nothing to paste either — and the
    // timeline's own clipboard is untouched, so the clip the user copied
    // before this is still theirs to paste.
    held = null;
    throw err;
  }
  // The frame drew, so it is the clipboard's contents now; a timeline copy no
  // longer outranks it at the next ⌘V.
  useEditor.getState().clearClipboard();
  if (!(await wroteOk)) throw new Error("The browser refused the clipboard write.");
}

/** Whether a copied frame is waiting for ⌘V. */
export const hasCopiedFrame = (): boolean => held !== null;

/** Forget the copied frame — a ⌘C on the timeline is the newer copy. */
export const clearCopiedFrame = (): void => {
  held = null;
};

/** The still's file name and display name for the moment it was taken. */
function stillNames(at: number): { fileName: string; name: string } {
  const stamp = stampOf(at);
  return {
    fileName: `frame-${stamp.replace(":", "m")}s-${crypto.randomUUID().slice(0, 4)}.png`,
    name: `Frame ${stamp}`,
  };
}

/** Store a composited still as a project image, named for the moment it was
 * taken. Created media, so it carries the freeze origin and stays out of the
 * Media panel. */
export async function storeStageStill(
  projectId: string,
  png: Blob,
  at: number,
  failMessage?: string
): Promise<MediaAsset> {
  const { fileName, name } = stillNames(at);
  const body = await uploadProjectImage(projectId, png, fileName, {
    name,
    ...(failMessage ? { failMessage } : {}),
  });
  return { ...body, origin: "freeze" };
}

/** The copied frame as a file to import, or null when nothing is held. The
 * hold survives the paste, so the same frame drops as many times as ⌘V is
 * pressed. */
export async function copiedFrameFile(): Promise<{ file: File; name: string } | null> {
  const frame = held;
  if (!frame) return null;
  const png = await frame.png;
  const { fileName, name } = stillNames(frame.at);
  return { file: new File([png], fileName, { type: "image/png" }), name };
}
