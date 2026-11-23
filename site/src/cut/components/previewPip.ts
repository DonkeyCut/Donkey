"use client";

/**
 * The cut in a picture-in-picture window while the editor is out of sight.
 *
 * A playing cut follows the person when they minimize the window or switch
 * tabs: the browser asks the page into picture-in-picture, and the page
 * answers with its own window. The preview is a canvas with the titles,
 * captions and elements laid over it as page elements, so there is no single
 * video for the browser to float. The window is a small document of its own
 * (Document Picture-in-Picture), and the stage — canvas and overlays together —
 * moves into it whole. React keeps rendering into the moved nodes and the
 * frame loop follows the canvas to the window showing it, so the floating
 * picture is the preview itself, playing. Coming back to the editor closes the
 * window and moves the stage home.
 *
 * The browser asks only a page whose media holds audio focus, and the
 * preview's sound comes from Web Audio, which takes none. So while the cut
 * plays, a silent looping audio element plays with it: the page holds focus,
 * the mix makes it audible, and the system's media controls play and pause
 * the cut.
 *
 * The window is for watching: a click or Space plays and pauses. Browsers
 * without Document Picture-in-Picture, or without automatic entry, keep the
 * editor as it is.
 */

import { playheadAt } from "@/cut/lib/playhead";
import { projectDuration, useEditor } from "@/cut/lib/store";
import { SURFACE_MOVED } from "@/cut/hooks/usePlayback";

/** The box a new window opens to fit, in CSS pixels. */
const PIP_BOX = { w: 640, h: 360 };

/** The silent loop's format: 8 kHz mono 8-bit PCM. Chrome counts media of 5
 * seconds or less as a sound effect, which never takes audio focus, so the
 * loop runs past that. */
const SILENCE = { rate: 8000, seconds: 10 };
/** Silence in unsigned 8-bit PCM sits at the middle of the range. */
const PCM8_ZERO = 128;

/** What the browser exposes; the DOM typings do not carry it yet. */
type PipApi = {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
};

/** The open window and what closing it undoes. */
type Floated = {
  win: Window;
  frame: HTMLDivElement;
  stage: HTMLElement;
  /** The stage's box in the editor, which it goes back into. */
  home: Node;
  /** Removes the listeners opening added to the editor's document. */
  unlisten: () => void;
};

let stage: HTMLElement | null = null;
let floated: Floated | null = null;
let opening = false;
let size = { w: 0, h: 0 };
let presence: { el: HTMLAudioElement; unwatch: () => void } | null = null;

/** The browser's picture-in-picture window API, in a top-level window only. */
function pipApi(): PipApi | null {
  if (typeof window === "undefined" || window.top !== window.self) {
    return null;
  }
  return (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture ?? null;
}

/**
 * The stage the window shows. The preview registers it on mount and clears it
 * on unmount, which closes a window still open. While a stage is registered,
 * the browser may float it when the page is hidden mid-play.
 */
export function setPipStage(el: HTMLElement | null) {
  stage = el;
  autoEnter(el ? openPip : null);
  if (el) {
    holdFocus();
    return;
  }
  releaseFocus();
  closePip();
}

/**
 * Play the silent loop for as long as the cut plays, and answer the system's
 * play and pause with the cut's own. The play that starts the cut is a click
 * or a key, which is what lets the element start with sound.
 */
function holdFocus() {
  if (presence || !pipApi() || !navigator.mediaSession) {
    return;
  }
  const el = new Audio(silentWav());
  el.loop = true;
  const follow = (playing: boolean) => {
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    if (!playing) {
      el.pause();
      return;
    }
    void el.play().catch(() => {});
  };
  follow(useEditor.getState().playing);
  const unwatch = useEditor.subscribe((s, prev) => {
    if (s.playing !== prev.playing) {
      follow(s.playing);
    }
  });
  navigator.mediaSession.setActionHandler("play", () => useEditor.getState().setPlaying(true));
  navigator.mediaSession.setActionHandler("pause", () => useEditor.getState().setPlaying(false));
  presence = { el, unwatch };
}

function releaseFocus() {
  if (!presence) {
    return;
  }
  presence.unwatch();
  presence.el.pause();
  URL.revokeObjectURL(presence.el.src);
  presence = null;
  navigator.mediaSession.setActionHandler("play", null);
  navigator.mediaSession.setActionHandler("pause", null);
  navigator.mediaSession.playbackState = "none";
}

/** A WAV of silence, as an object URL. */
function silentWav(): string {
  const samples = SILENCE.rate * SILENCE.seconds;
  const bytes = new DataView(new ArrayBuffer(44 + samples));
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      bytes.setUint8(at + i, value.charCodeAt(i));
    }
  };
  text(0, "RIFF");
  bytes.setUint32(4, 36 + samples, true);
  text(8, "WAVE");
  text(12, "fmt ");
  bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, 1, true);
  bytes.setUint32(24, SILENCE.rate, true);
  bytes.setUint32(28, SILENCE.rate, true);
  bytes.setUint16(32, 1, true);
  bytes.setUint16(34, 8, true);
  text(36, "data");
  bytes.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) {
    bytes.setUint8(44 + i, PCM8_ZERO);
  }
  return URL.createObjectURL(new Blob([bytes.buffer], { type: "audio/wav" }));
}

/** The stage's size in the editor: overlays are laid out in these pixels, so
 * the window shows the stage at this size, scaled to fit. */
export function fitPipStage(w: number, h: number) {
  size = { w, h };
  refit();
}

/** The play button's toggle, from the end starting over. */
function togglePlay() {
  const s = useEditor.getState();
  if (!s.playing && playheadAt() >= projectDuration(s) - 0.01) {
    s.seek(0);
  }
  s.setPlaying(!s.playing);
}

function autoEnter(handler: (() => void) | null) {
  if (typeof navigator === "undefined" || !navigator.mediaSession || !pipApi()) {
    return;
  }
  // Browsers that do not know the action throw on it.
  try {
    navigator.mediaSession.setActionHandler("enterpictureinpicture" as MediaSessionAction, handler);
  } catch {
    // No automatic entry in this browser; the editor stays as it is.
  }
}

/** Open the window and move the stage into it. A paused cut stays put. */
async function openPip() {
  const api = pipApi();
  if (!api || !stage || floated || opening || !size.w || !size.h || !useEditor.getState().playing) {
    return;
  }
  opening = true;
  const fit = Math.min(PIP_BOX.w / size.w, PIP_BOX.h / size.h);
  let win: Window;
  try {
    win = await api.requestWindow({ width: Math.round(size.w * fit), height: Math.round(size.h * fit) });
  } finally {
    opening = false;
  }
  const el = stage;
  const home = el?.parentNode;
  if (!el || !home || document.visibilityState === "visible") {
    win.close();
    return;
  }
  const doc = win.document;
  copyPage(doc);

  // A black room with the stage centered in it at its editor size, scaled.
  doc.body.style.cssText = "margin:0;overflow:hidden;background:#000;height:100vh;cursor:pointer";
  const frame = doc.createElement("div");
  frame.style.cssText = "position:absolute;left:50%;top:50%;transform-origin:center";
  frame.append(el);
  doc.body.append(frame);

  // Either window coming or going changes which one paces the frames, and the
  // editor coming back closes the window.
  const rebook = () => surfaceMoved(el);
  const onEditorShown = () => {
    rebook();
    if (document.visibilityState === "visible") {
      closePip();
    }
  };
  doc.addEventListener("visibilitychange", rebook);
  document.addEventListener("visibilitychange", onEditorShown);

  // A font picked or added while the window is open reaches it too: a Google
  // font announces itself when it loads, the person's own font with its asset.
  const fonts = () => syncFonts(doc);
  document.fonts.addEventListener("loadingdone", fonts);
  const unwatch = useEditor.subscribe((s, prev) => {
    if (s.assets !== prev.assets) {
      fonts();
    }
  });

  floated = {
    win,
    frame,
    stage: el,
    home,
    unlisten: () => {
      document.removeEventListener("visibilitychange", onEditorShown);
      document.fonts.removeEventListener("loadingdone", fonts);
      unwatch();
    },
  };
  refit();
  rebook();

  win.addEventListener("resize", refit);
  win.addEventListener("pagehide", restore, { once: true });
  doc.addEventListener("click", togglePlay);
  doc.addEventListener("keydown", (e) => {
    if (e.code !== "Space") {
      return;
    }
    e.preventDefault();
    togglePlay();
  });
}

function closePip() {
  if (!floated) {
    return;
  }
  const { win } = floated;
  restore();
  win.close();
}

/** Put the stage back where it lives in the editor: the first child of its
 * box, under the selection chrome. */
function restore() {
  if (!floated) {
    return;
  }
  const { stage: el, home, unlisten } = floated;
  floated = null;
  unlisten();
  home.insertBefore(el, home.firstChild);
  surfaceMoved(el);
}

function refit() {
  if (!floated || !size.w || !size.h) {
    return;
  }
  const { win, frame } = floated;
  const scale = Math.min(win.innerWidth / size.w, win.innerHeight / size.h);
  frame.style.width = `${size.w}px`;
  frame.style.height = `${size.h}px`;
  frame.style.transform = `translate(-50%, -50%) scale(${scale})`;
}

/** Tell the canvases their window changed, so the frame loop books its next
 * frame on the one showing them. */
function surfaceMoved(el: HTMLElement) {
  for (const canvas of el.querySelectorAll("canvas")) {
    canvas.dispatchEvent(new Event(SURFACE_MOVED));
  }
}

/**
 * Give the window the page's styles, theme and fonts: the stylesheets as
 * text where they can be read and as links where they cannot, the root's
 * classes and attributes (dark mode, theme variables), and every font face
 * the page installed by script — the person's own fonts and Google fonts.
 */
function copyPage(doc: Document) {
  const base = doc.createElement("base");
  base.href = document.baseURI;
  doc.head.append(base);
  for (const sheet of document.styleSheets) {
    try {
      const style = doc.createElement("style");
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
      doc.head.append(style);
    } catch {
      if (!sheet.href) {
        continue;
      }
      const link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      doc.head.append(link);
    }
  }
  for (const attr of document.documentElement.attributes) {
    doc.documentElement.setAttribute(attr.name, attr.value);
  }
  syncFonts(doc);
}

function syncFonts(doc: Document) {
  for (const face of document.fonts) {
    if (!doc.fonts.has(face)) {
      doc.fonts.add(face);
    }
  }
}
