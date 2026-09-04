import {
  behindSubjectMask,
  overlayKind,
  poseAt,
  retimeOf,
  stampOverlayKinds,
  stripDefaultOverlayKinds,
  type ClipRemoval,
  type ClipSound,
  type ColorGrade,
  type EffectOverlay,
  type LookStyle,
  type Mask,
  type OverlayBase,
  type OverlayKey,
  type OverlayKind,
  type OverlayPose,
  type ShapeKind,
  type ShapeOverlay,
  type SpeedNode,
  type StickerOverlay,
  type TextOverlay as KitTextOverlay,
  type WordEffectId,
} from "@donkeycut/effects-kit";
import { getBackend, type CutBackend } from "./backend";
import type { VideoProject } from "./genvideo/types";

export type AssetType = "video" | "audio" | "image" | "font";

/** Default on-timeline length (seconds) a still image occupies when placed —
 * an image has no intrinsic duration, so the clip carries this as its `out`. */
export const IMAGE_CLIP_SECONDS = 8;

/** Project output frame ratio as "W:H". Presets cover common platforms;
 * any ratio that passes `parseRatio` (e.g. "9:5") is valid. */
export type Aspect = `${number}:${number}`;

/** Parse a "W:H" ratio. Null unless both sides are positive integers up to
 * three digits and the long/short ratio is at most 8 (keeps ffmpeg output
 * dims and text layout sane). */
export function parseRatio(a: string | undefined | null): { w: number; h: number } | null {
  const m = /^(\d{1,3}):(\d{1,3})$/.exec(a ?? "");
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h || Math.max(w, h) / Math.min(w, h) > 8) return null;
  return { w, h };
}

/** Reduce a ratio to the one canonical string: lowest-terms whole numbers.
 * Sides may carry up to two decimals — "1.85:1" → "37:20", "18:32" and
 * "09:16" both → "9:16" — so preset checks and literal comparisons see a
 * single spelling. Sides take up to four digits so a frame size is a legal way
 * to say a ratio ("1280:720" → "16:9"). Null when invalid: non-positive, more
 * extreme than 8:1, or not expressible with whole sides up to 999. */
export function normalizeAspect(a: string | undefined | null): Aspect | null {
  const m = /^(\d{1,4}(?:\.\d{1,2})?):(\d{1,4}(?:\.\d{1,2})?)$/.exec(a ?? "");
  if (!m) return null;
  const scale = 10 ** Math.max(m[1].split(".")[1]?.length ?? 0, m[2].split(".")[1]?.length ?? 0);
  let w = Math.round(Number(m[1]) * scale);
  let h = Math.round(Number(m[2]) * scale);
  if (!w || !h || Math.max(w, h) / Math.min(w, h) > 8) return null;
  const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
  const g = gcd(w, h);
  w /= g;
  h /= g;
  if (w > 999 || h > 999) return null;
  return `${w}:${h}`;
}

/** An overlay's center, held far enough inside the frame that the element it
 * belongs to always has a grabbable piece on screen. Every path that writes a
 * position — dragging in the preview, the inspector's own fields — passes
 * through it, so no route can strand an element off-frame. */
export const clampOverlayPos = (v: number) => Math.min(0.98, Math.max(0.02, v));

/** Output frame in pixels. The short side is pinned to 1080 — the design
 * short side that text scaling and overlay math assume — and the long side
 * follows the ratio, rounded to even for the encoder. */
export function frameOf(aspect: Aspect): { w: number; h: number } {
  const r = parseRatio(aspect) ?? { w: 9, h: 16 };
  const long = 2 * Math.round((1080 * Math.max(r.w, r.h)) / Math.min(r.w, r.h) / 2);
  return r.w >= r.h ? { w: long, h: 1080 } : { w: 1080, h: long };
}

export const ASPECT_PRESETS: { value: Aspect; name: string; sublabel?: string }[] = [
  { value: "16:9", name: "Widescreen", sublabel: "YouTube" },
  { value: "9:16", name: "Vertical", sublabel: "TikTok, Reels, Shorts" },
  { value: "4:3", name: "Classic" },
  { value: "2:1", name: "Cinematic" },
  { value: "1:1", name: "Square" },
  { value: "3:4", name: "Portrait" },
];

export function aspectLabel(aspect: Aspect): string {
  const preset = ASPECT_PRESETS.find((p) => p.value === aspect);
  return preset ? `${preset.name} · ${preset.value}` : `Custom · ${aspect}`;
}

export function aspectOrientation(aspect: Aspect): "landscape" | "portrait" | "square" {
  const r = parseRatio(aspect) ?? { w: 9, h: 16 };
  return r.w === r.h ? "square" : r.w > r.h ? "landscape" : "portrait";
}

/** Which shape band a w×h frame tiles with. The log of the ratio, in coarse
 * steps: 16:9 bands with 3:2, while 4:3, 1:1, 3:4, and 9:16 each band apart —
 * any ratio lands somewhere, with no landscape/portrait dichotomy. */
export function shapeBand(w: number, h: number): number {
  return Math.round(Math.log2(w / h) * 3);
}

/** Project the project aspect onto a model/provider's supported ratio list:
 * the entry whose shape is closest (log-ratio distance), first entry on ties. */
export function nearestAspect<T extends string>(aspect: Aspect, supported: readonly T[]): T {
  const r = parseRatio(aspect) ?? { w: 9, h: 16 };
  const target = Math.log(r.w / r.h);
  let best = supported[0];
  let bestDist = Infinity;
  for (const s of supported) {
    const sr = parseRatio(s);
    if (!sr) continue;
    const dist = Math.abs(Math.log(sr.w / sr.h) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

/** Asset fields persisted in project.json. */
/** Why watch_video kept a frame: "first" opens the range, "global" is a
 * whole-frame change (a hard cut), "action" is hard local motion (a small
 * subject), "settled" is new settled detail (text, ink, UI). */
export type WatchKeepReason = "first" | "global" | "action" | "settled";

/** What the assistant has seen of a source: watch_video's kept frames and
 * detected cuts, merged across the watched spans. Times are source seconds.
 * Media files are immutable per fileName, so this never goes stale; it lives
 * on the asset, so it saves with the project and dies with the asset. */
export interface AssetWatch {
  /** Watched source spans, merged and ascending. */
  ranges: { from: number; to: number }[];
  /** Kept distinct frames, ascending, each with why it was kept. */
  frames: { t: number; via: WatchKeepReason }[];
  /** Hard-cut moments among the kept frames. */
  sceneChanges: number[];
  /** What the assistant read off the source, in its own words, against the
   * span it read it from. Contact sheets leave the conversation as it grows;
   * these stay, so a source longer than one look can be decided from the
   * record instead of watched again. */
  notes?: { from: number; to: number; text: string }[];
}

/** A source's own transcript — working data for the assistant, kept apart
 * from subtitle tracks (those are user-visible and only written on request).
 * Times are source seconds. Same lifecycle as AssetWatch: saves with the
 * project, dies with the asset, never stale (media files are immutable). */
export interface AssetSpeech {
  /** Transcribed source spans, merged and ascending. */
  ranges: { from: number; to: number }[];
  /** Timed speech segments, ascending. */
  segments: { start: number; end: number; text: string }[];
  /** Set once the whole source is covered and no speech was heard — a
   * result, so silent sources are never re-transcribed. */
  noSpeech?: true;
  locale?: string;
}

/** The source's musical beat grid, in source seconds. Detected from the
 * audio, then the user's to edit: the dots on a clip move, add, and delete
 * beats by hand. Same lifecycle as AssetSpeech: saves with the project, dies
 * with the asset, never stale (media files are immutable). */
export interface AssetBeats {
  /** Beat moments, ascending. */
  beats: number[];
  /** Tempo of the detected grid, BPM; 0 once the grid is hand-placed. */
  bpm: number;
}

export interface StoredAsset {
  id: string;
  fileName: string; // file inside the project's media/ folder
  name: string; // original display name
  type: AssetType;
  duration: number; // seconds
  width?: number;
  height?: number;
  /** Watch metadata for video sources — what the assistant has seen. */
  watch?: AssetWatch;
  /** The source's own transcript — what the assistant has heard. */
  speech?: AssetSpeech;
  /** The music's beat grid — dots on the clip, snap targets for every edge. */
  beats?: AssetBeats;
  /** How this asset entered the project. Absent = the user imported it (drag,
   * drop, or upload), so it belongs in the Media panel. Any value marks media
   * Cut created or fetched — it lives where it was made (the timeline, a
   * generation panel, or an AI chat card) and is kept out of the Media panel. */
  origin?: "voiceover" | "generated" | "recording" | "stock" | "freeze" | "chat" | "sticker" | "matte";
  /** BCP-47 of the audio's spoken language, when known (stamped on voiceovers
   * at synthesis) — what transcription should run its recognizer in. */
  language?: string;
  /** Scene changes detected in the source at import (seconds, near frame
   * accurate). The timeline strip splits its tiles on these so the strip
   * changes picture where the source does. */
  sceneCuts?: number[];
  /** For origin "chat": the chat thread that made it. Deleting that thread
   * deletes the assets it still owns (see chatAssets.ts). */
  chatId?: string;
  /** Media panel folder this file is filed in (see ProjectDoc.mediaFolders);
   * absent/null = the panel's top level. */
  folderId?: string | null;
}

/** A folder in the Media panel's Project Files view — a flat, project-local
 * grouping of user imports; assets point at one via `folderId`. */
export interface MediaFolder {
  id: string;
  name: string;
  createdAt: number;
}

/** Most labels one note may wear. Both clients hold the line at this — the
 * picker stops offering more — and the write is refused past it, so a note
 * never comes back from the server quietly wearing fewer labels than the
 * person put on it. */
export const NOTE_LABELS_MAX = 20;

/** True for an asset that carries no sound. Only video and audio files hold an
 * audio track; a still (a freeze frame, an imported image) is not a media
 * container at all, and handing its URL to the audio reader fails the read
 * rather than returning silence. Every path that asks a source for audio —
 * the mix, the transcribe spec, the preview's voices — asks this first. */
export const assetIsSilent = (asset: Pick<StoredAsset, "type">): boolean =>
  asset.type !== "video" && asset.type !== "audio";

/** An import whose bytes are still on their way to storage. While this is set
 * the asset plays from a local object URL. Whether it may join the saved
 * document depends on where the bytes live: an upload holding only tab-scoped
 * bytes is held out along with the clips that use it — a reload cannot resume
 * them, so a doc pointing at them would open broken. One whose bytes sit in
 * the browser store survives a reload and saves like any other asset; the
 * store's ledger re-marks it pending on the next open. */
export interface AssetUpload {
  /** Share of the bytes sent, 0..1. */
  progress: number;
  /** Set when the upload failed; the asset is retryable until it is removed. */
  error?: string;
  /** The bytes are held durably in the browser store, so the asset is safe to
   * save and the upload safe to resume after a reload. */
  stored?: boolean;
  /** The bytes move server-side, shelf to project, and nothing leaves the
   * browser: a library file landing in a project on its own shelf. */
  server?: boolean;
}

/** Runtime asset: stored fields plus derived/browser-only data. */
export interface MediaAsset extends StoredAsset {
  url: string; // /api/cut/projects/<id>/media/<fileName>
  /** Filmstrip frames (video only), evenly spaced every `thumbStep` seconds. */
  thumbs?: string[];
  thumbStep?: number;
  /** Normalized waveform peaks 0..1 (audio only). */
  peaks?: number[];
  /** Present only while the file is still uploading. */
  upload?: AssetUpload;
}

/**
 * A layout region inside the output frame, as fractions with a top-left origin
 * (x,y = top-left corner; w,h = size). Absent on a clip means it fills the
 * whole frame. Regions let two videos share one frame — split top/bottom or
 * side by side — or place one small (picture-in-picture).
 */
export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_FRAME: FrameRect = { x: 0, y: 0, w: 1, h: 1 };

/** Decorative styling on a clip's box, off until the user turns it on:
 * rounded corners trim the picture, and a stroke draws along the box edge.
 * Lengths are design px at the 1080 short side, like mask feather/radius. */
export interface BoxStyle {
  /** Corner radius, design px. */
  radius?: number;
  /** Border stroke width, design px; 0/absent draws no stroke. */
  borderWidth?: number;
  /** Border stroke color (hex). */
  borderColor?: string;
  /** Drop shadow cast by the clip's own shape — its box, its rounded corners,
   * its mask. Absent = none. */
  shadow?: ClipShadow;
}

/** A drop shadow's ink and throw. Lengths are design px at the 1080 short
 * side, like the rest of BoxStyle. */
export interface ClipShadow {
  /** Blur radius; 0 casts a hard-edged copy. */
  blur: number;
  /** Offset; absent = straight down by nothing. */
  x?: number;
  y?: number;
  /** Ink (hex); absent = black. */
  color?: string;
  /** 0..1; absent = 0.35. */
  opacity?: number;
}

/** The shadow's ink as a CSS color, ready for a canvas shadow. */
export function shadowInk(sh: ClipShadow): string {
  const hex = (sh.color ?? "#000000").replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const n = parseInt(full.slice(0, 6) || "000000", 16);
  const a = Math.max(0, Math.min(1, sh.opacity ?? 0.35));
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** How far a region box may oversize the frame on each axis. Oversizing is
 * the zoom-into-an-area move; the ceiling keeps export scale targets and
 * mask canvases within what ffmpeg and browser canvases handle. */
export const REGION_MAX_SCALE = 3;

/** How far a clip's picture may zoom past the size its box fits it to. The
 * ceiling keeps export scale targets inside what ffmpeg and browser canvases
 * handle, the same reason `REGION_MAX_SCALE` has one. */
export const CLIP_MAX_ZOOM = 4;

/** A clip's zoom, clamped to what every surface renders. */
export const clipZoom = (c: { zoom?: number }): number =>
  Math.max(1, Math.min(CLIP_MAX_ZOOM, c.zoom ?? 1));

/**
 * Where a clip's picture lands inside a box, in the box's own units: fitted
 * (letterboxed) or covering (cropped), zoomed, and slid by the pan.
 *
 * The preview outlines this rect, the compositor draws into it, and the export
 * graph scales and crops to the same numbers; one geometry keeps the three in
 * step.
 */
export function contentRect(
  box: { x: number; y: number; w: number; h: number },
  srcW: number,
  srcH: number,
  cover: boolean,
  zoom = 1,
  panX = 0,
  panY = 0
): { x: number; y: number; w: number; h: number } {
  // The clip's own zoom arrives already clamped (`clipZoom`); a transition's
  // push rides on top of it and may pull below 1, so nothing is clamped here.
  const z = zoom > 0 ? zoom : 1;
  const base = cover
    ? Math.max(box.w / srcW, box.h / srcH)
    : Math.min(box.w / srcW, box.h / srcH);
  const w = srcW * base * z;
  const h = srcH * base * z;
  // Centered, then slid by the pan across whatever overflows the box — an axis
  // with nothing to spare stays centered, which is the export's
  // `crop=min(iw,box)` on the same picture.
  const kx = 0.5 + Math.max(-1, Math.min(1, panX)) / 2;
  const ky = 0.5 + Math.max(-1, Math.min(1, panY)) / 2;
  return {
    x: box.x + (box.w - w) / 2 + Math.max(0, w - box.w) * (0.5 - kx),
    y: box.y + (box.h - h) / 2 + Math.max(0, h - box.h) * (0.5 - ky),
    w,
    h,
  };
}

/** Whether a clip's picture covers its box, cropping what hangs over. Track 0
 * letterboxes until it is told to fill; a clip on an upper track with the whole
 * frame to itself covers by default, since it stands in for the picture
 * beneath it. */
export const clipCovers = (c: {
  fit?: "fit" | "fill";
  frame?: FrameRect;
  track?: number;
}): boolean =>
  c.fit === "fill" || (c.fit == null && (c.track ?? 0) > 0 && isFullRect(rectOf(c)));

/** A clip's effective region: its own `frame`, or the full frame if unset. */
export function rectOf(clip: { frame?: FrameRect }): FrameRect {
  return clip.frame ?? FULL_FRAME;
}

/** Whether a region matches the whole frame (so it needs no special layout).
 * An oversized or shifted region counts as regioned — it crops to the frame. */
export function isFullRect(r: FrameRect): boolean {
  return (
    Math.abs(r.x) <= 0.001 &&
    Math.abs(r.y) <= 0.001 &&
    Math.abs(r.w - 1) <= 0.001 &&
    Math.abs(r.h - 1) <= 0.001
  );
}

/** A region's pixel box at an output size, even-rounded — the one rounding
 * that decides where a regioned clip's segment sits. The ffmpeg graph frames
 * segments with it and the export client paints mask coverage with it, so
 * the two land on identical pixels. The box may reach past the frame edges
 * (up to REGION_MAX_SCALE per axis — the same ceiling the resize handle
 * enforces, applied again here so a stored oversize can never blow up the
 * export); the graph crops the frame window back out. Null for the full
 * frame, judged with isFullRect's tolerance so a nudged-by-a-hair rect lays
 * out exactly like the full frame it visually is. */
export function regionPx(
  frame: { x: number; y: number; w: number; h: number } | undefined,
  W: number,
  H: number
): { rx: number; ry: number; rw: number; rh: number } | null {
  if (!frame || isFullRect(frame)) return null;
  const even = (n: number) => 2 * Math.round(n / 2);
  const rw = Math.min(even(REGION_MAX_SCALE * W), Math.max(2, even(frame.w * W)));
  const rh = Math.min(even(REGION_MAX_SCALE * H), Math.max(2, even(frame.h * H)));
  const rx = even(frame.x * W);
  const ry = even(frame.y * H);
  if (rx === 0 && ry === 0 && rw === W && rh === H) return null;
  return { rx, ry, rw, rh };
}

/** Whether the clip carries pose keys worth evaluating. */
export const clipKeyed = (c: { kf?: OverlayKey[] }): boolean => !!c.kf && c.kf.length > 0;

/** Whether the clip's picture needs the pose pass at all: a key track, or a
 * resting turn or fade the compositor has to blit rather than draw. */
export const clipPosed = (c: {
  kf?: OverlayKey[];
  rotation?: number;
  opacity?: number;
}): boolean =>
  clipKeyed(c) || Math.abs(c.rotation ?? 0) > 0.001 || (c.opacity ?? 1) < 0.999;

/**
 * The clip's pose at `tLocal` seconds into its window: resting at its region
 * center, or moving along its key track — the overlay evaluator over the
 * clip's own anchor, so clips and elements share one interpolation.
 */
export function clipPoseAt(
  clip: {
    frame?: FrameRect;
    in: number;
    out: number;
    speed?: number;
    speedCurve?: SpeedNode[];
    reverse?: boolean;
    rotation?: number;
    opacity?: number;
    kf?: OverlayKey[];
  },
  tLocal: number
): OverlayPose {
  const rect = rectOf(clip);
  const len = Math.max(0.1, retimeOf(clip).len);
  return poseAt(
    {
      start: 0,
      end: len,
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2,
      rotation: clip.rotation,
      opacity: clip.opacity,
      kf: clip.kf,
    },
    tLocal
  );
}

/** One-click layouts for arranging a video layer in the frame. `fit` is the
 * sensible default meeting for that shape: halves cover their region, a corner
 * is contained so the whole picture shows. */
export const LAYOUTS = {
  full: { label: "Full", rect: FULL_FRAME, fit: "fit" as const },
  top: { label: "Top", rect: { x: 0, y: 0, w: 1, h: 0.5 }, fit: "fill" as const },
  bottom: { label: "Bottom", rect: { x: 0, y: 0.5, w: 1, h: 0.5 }, fit: "fill" as const },
  left: { label: "Left", rect: { x: 0, y: 0, w: 0.5, h: 1 }, fit: "fill" as const },
  right: { label: "Right", rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, fit: "fill" as const },
  corner: { label: "PiP", rect: { x: 0.62, y: 0.62, w: 0.34, h: 0.34 }, fit: "fit" as const },
} as const;

export type LayoutId = keyof typeof LAYOUTS;

/** A short human label for a region: a named layout if it matches one, else
 * "Full" or "PiP". Used on timeline bars and the inspector. */
export function regionLabel(r: FrameRect): string {
  if (isFullRect(r)) return LAYOUTS.full.label;
  for (const key of ["top", "bottom", "left", "right"] as const) {
    const q = LAYOUTS[key].rect;
    const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
    if (near(q.x, r.x) && near(q.y, r.y) && near(q.w, r.w) && near(q.h, r.h)) {
      return LAYOUTS[key].label;
    }
  }
  return "PiP";
}

/** A clip on video track 0 — free-positioned in time like every other track.
 * The array is kept sorted by `start` (older docs stored a packed sequence;
 * loading bakes their implied starts in). */
export interface VideoClip {
  id: string;
  assetId: string;
  /** Which video track this clip sits on. Tracks number 0..N bottom-up:
   * track 0's clips form the sequence that drives playback; higher tracks
   * composite in front (highest wins where clips overlap). Every track
   * carries transitions between its own clips. Absent in older docs, which
   * are all track 0; docs saved when tracks could go negative lift on load
   * so the lowest row becomes 0. */
  track: number;
  start: number; // timeline position, seconds
  in: number; // trim-in inside the source, seconds
  out: number; // trim-out inside the source, seconds
  muted: boolean;
  /** Gain on the clip's own audio, 0..3; absent = 1 (unchanged). */
  volume?: number;
  /** The clip's own sound treatment — equalizer, compressor, limiter — run
   * on its sound alone, before its fades; absent = untouched. */
  sound?: ClipSound;
  /** How the clip meets its region: letterboxed ("fit", default) or scaled to
   * cover it ("fill", cropping the overflow). */
  fit?: "fit" | "fill";
  /** The region of the frame this clip occupies; absent = full frame. Lets a
   * clip share the frame with another track (e.g. a split-screen half) or float
   * small over it (picture-in-picture). */
  frame?: FrameRect;
  /** How far the picture zooms past the size its box fits it to, 1..
   * CLIP_MAX_ZOOM; absent = 1. Zooming crops, so the pan below chooses what
   * stays visible. */
  zoom?: number;
  /** Crop-window pan, -1..1 per axis (0 = centered): which part of an
   * oversized picture stays visible. Live whenever the picture overflows its
   * box — covering it, zoomed into it, or both. */
  panX?: number;
  panY?: number;
  /** Resting turn, degrees clockwise about the box center; absent = upright.
   * A pose key track overrides it while it plays. */
  rotation?: number;
  /** Resting opacity 0..1; absent = opaque. */
  opacity?: number;
  /** Playback rate, default 1 (absent). The source (out-in) seconds play in
   * (out-in)/speed timeline seconds, so >1 is faster and shorter. */
  speed?: number;
  /** A rate that changes through the footage: nodes of [source second, rate]
   * joined by a smooth curve, held flat past the outermost nodes. Present, it
   * is the clip's rate and `speed` is ignored; the timeline footprint is the
   * integral of the curve over the trim (see retimeOf). Nodes sit in source
   * seconds, so trims and splits leave them where they are. */
  speedCurve?: SpeedNode[];
  /** Plays the footage backward: the head of the clip shows `out` and the
   * tail shows `in`, picture and sound alike. The rate still applies, so the
   * footprint is unchanged. */
  reverse?: boolean;
  /** Transition into the next clip on this clip's track, in timeline seconds
   * (absent/0 = hard cut). Every style overlaps the two clips by this much,
   * so the cut shortens. On upper tracks a transition blends the incoming
   * clip in over the outgoing one (the tracks beneath show through). */
  transition?: number;
  /** Look of that transition; absent = "crossfade". */
  transitionStyle?: TransitionStyle;
  /** Entrance animation on this clip's own head (absent = none). Unlike a
   * transition it belongs to one clip and never moves its neighbors. */
  animIn?: ClipAnim;
  /** Exit animation on this clip's own tail (absent = none). */
  animOut?: ClipAnim;
  /** Preset filter look baked over the clip's picture (absent = none).
   * Composes with `grade`: the look is the base, manual adjustments ride on
   * top of it. */
  look?: LookStyle;
  /** Look strength 0..1; absent = 1 (full). */
  lookAmount?: number;
  /** Hidden clips stay on the timeline (grayed) but render as black — excluded
   * from the played/exported picture without disturbing the layout. */
  hidden?: boolean;
  /** Manual color adjustments; absent when every value is neutral. */
  grade?: ColorGrade;
  /** Coverage that trims the clip's picture to a shape (see the kit's
   * mask.ts); absent = the whole picture shows. Anchored on the clip's
   * region center. */
  mask?: Mask;
  /** Keyframed pose track (see the kit's keys.ts), seconds from the clip's
   * timeline start: x/y move the picture's center (frame fractions), scale
   * multiplies its fitted size, rotation turns it about its center, opacity
   * fades it. Absent = the clip sits in its region untransformed. */
  kf?: OverlayKey[];
  /** Rounded corners and a border stroke on the clip's box; absent = plain. */
  boxStyle?: BoxStyle;
  /** Background removal: keys the clip's picture to an AI matte baked to a
   * grayscale video asset, with an optional stroke around the silhouette and
   * a backdrop filled in behind it (see the kit's removal.ts). Absent = the
   * whole picture shows. */
  removal?: ClipRemoval;
}

// Color grading (the dual-renderer math) lives in the effects kit; the model
// types and ranges re-export here so doc-model consumers keep one import.
export { GRADE_BASIC_FIELDS, GRADE_HUE_MAX, GRADE_MAX, HSL_BANDS } from "@donkeycut/effects-kit";
export type { ClipSound, ColorGrade, GradePresetRef, HslBand, SpeedNode } from "@donkeycut/effects-kit";

// Background removal follows the same split: math and model in the kit, the
// doc-model types re-exported here.
export {
  removalActive,
  removalFingerprint,
  removalNeedsBake,
  STROKE_STYLE_LABELS,
  STROKE_STYLES,
} from "@donkeycut/effects-kit";
export type {
  ClipRemoval,
  RemovalBackdrop,
  RemovalMode,
  RemovalSeeds,
  RemovalStroke,
  StrokeStyleId,
} from "@donkeycut/effects-kit";

/** Speed slider range. Typed entry and tools may go beyond it; SPEED_FLOOR is
 * the only hard bound, keeping rates positive so length math stays finite. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
export const SPEED_FLOOR = 0.05;
/** Longest transition offered; also clamps against the clips it joins. */
export const TRANSITION_MAX = 2;
/** What a transition runs for when one is placed on a bare cut. */
export const TRANSITION_DEFAULT_SECONDS = 0.5;
/**
 * What a cross dissolve runs for instead — shorter, because the ear is less
 * forgiving than the eye.
 *
 * The crossing is centered on the cut, so both clips are speaking for its
 * whole length. Long enough and the outgoing line is still audible under the
 * incoming one, which reads as a mistake; this is the length that covers the
 * jump in room tone at a cut without letting two voices be heard at once. It
 * also asks less of the handles either side, so the handover is a real
 * crossing more often.
 */
export const CROSS_DISSOLVE_DEFAULT_SECONDS = 0.3;

/** How long a bar of this style runs when it lands on a bare cut. */
export const transitionDefaultSeconds = (style: TransitionStyle): number =>
  isAudioTransition(style) ? CROSS_DISSOLVE_DEFAULT_SECONDS : TRANSITION_DEFAULT_SECONDS;

/** A transition as a timeline object of its own: a bar on the transitions row
 * at an absolute time, belonging to no clip. It plays when its window lines up
 * with a place that has a handover to make — a cut it ends on, an open head it
 * starts on, an open tail it ends on, a cut it straddles when it hands over on
 * the sound — and sits inert anywhere else. Clips moving or deleting leave it
 * exactly where it is. `transitionBarStart` is where the window falls against
 * the boundary. */
export interface TimelineTransition {
  id: string;
  /** Bar start on the timeline, seconds; the window is [start, start+seconds]. */
  start: number;
  /** Blend length, 0.1..TRANSITION_MAX. */
  seconds: number;
  style: TransitionStyle;
  /** Hidden bars stay on the row (grayed) and keep the boundary they line up
   * with, so nothing else claims it, but play nothing — the cut renders hard
   * in the preview and in every export. */
  hidden?: boolean;
}

/** Effective whole-video fade length: the stored seconds, capped at half the
 * project so a fade-in and fade-out never overlap. The one clamp preview and
 * export both apply, so a short project fades identically in the editor and the
 * rendered file. */
export function projectFadeSeconds(fade: number | undefined, duration: number): number {
  return Math.max(0, Math.min(fade ?? 0, duration / 2));
}

/** The frame color a project takes when it has not chosen one. Black is what
 * every cut rendered before the field existed, so an old document opens
 * looking exactly as it did. */
export const DEFAULT_BACKGROUND = "#000000";

/** A project's frame color as a `#RRGGBB` string. Anything unparseable — a
 * hand-edited document, a tool argument — falls back to the default rather
 * than reaching a canvas or an ffmpeg argument as garbage. */
export function projectBackground(raw: string | undefined | null): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((raw ?? "").trim());
  if (!m) return DEFAULT_BACKGROUND;
  const h = m[1];
  return `#${(h.length === 3 ? [...h].map((c) => c + c).join("") : h).toUpperCase()}`;
}

/** How a clip hands off to the next one. Every style is a render-time blend
 * across the outgoing clip's last transition-length seconds: the incoming
 * clip's first frame arrives over the live tail and playback hands over at
 * the cut. Layout never moves. Directional names describe the motion
 * (pushleft pushes the frame leftward; wipeleft's reveal edge travels
 * leftward). */
export type TransitionStyle =
  | "crossfade"
  | "crosszoom"
  | "dipblack"
  | "dipwhite"
  | "blur"
  | "pushleft"
  | "pushright"
  | "pushup"
  | "pushdown"
  | "wipeleft"
  | "wiperight"
  | "wipeup"
  | "wipedown"
  | "circleopen"
  | "circleclose"
  | "splitopen"
  | "splitclose"
  | "audiocross";

/** The ffmpeg xfade transition each style renders with on export. Doubles as
 * the sanitizing allowlist: the server looks the style up here and falls back
 * to plain "fade" for anything unknown. Cross zoom is a fade — its zoom
 * ramps ride the overlap as segment-edge zooms. */
export const TRANSITION_XFADE: Record<TransitionStyle, string> = {
  crossfade: "fade",
  crosszoom: "fade",
  dipblack: "fadeblack",
  dipwhite: "fadewhite",
  blur: "hblur",
  pushleft: "slideleft",
  pushright: "slideright",
  pushup: "slideup",
  pushdown: "slidedown",
  wipeleft: "wipeleft",
  wiperight: "wiperight",
  wipeup: "wipeup",
  wipedown: "wipedown",
  circleopen: "circleopen",
  circleclose: "circleclose",
  splitopen: "vertopen",
  splitclose: "vertclose",
  // The cross dissolve never reaches xfade — the picture cuts and the renders
  // branch before this map. The entry keeps the record total.
  audiocross: "fade",
};

/** The styles that hand over on the sound alone: the picture cuts while the
 * two clips ramp equal-power past each other across it, each reaching into
 * the media its trim left behind so both are audible through the join. They
 * take no picture blend, so a clip's own entrance and exit animations still
 * play across a cut one of them sits on. */
export const AUDIO_TRANSITION_STYLES: TransitionStyle[] = ["audiocross"];

export const isAudioTransition = (style: string | undefined): boolean =>
  !!style && (AUDIO_TRANSITION_STYLES as string[]).includes(style);

/** The kinds of place a bar can play: an open head, a cut, an open tail. */
export type TransitionBoundaryKind = "in" | "cut" | "out";

/**
 * Where a bar's window falls against the boundary at `at`.
 *
 * A picture blend runs across the outgoing clip's last seconds and hands over
 * at the cut, so the bar ends on the boundary; an entrance runs forward from
 * the clip's head. A cross dissolve crosses the cut itself — the outgoing
 * sound fades out into it while the incoming fades in out of it — so its bar
 * straddles the boundary, half its length either side.
 */
export const transitionBarStart = (
  style: TransitionStyle,
  kind: TransitionBoundaryKind,
  at: number,
  seconds: number
): number =>
  kind === "in" ? at : isAudioTransition(style) ? at - seconds / 2 : at - seconds;

/** The instant a bar claims for `kind` — the inverse of `transitionBarStart`,
 * and what every alignment test measures against a boundary. */
export const transitionBarAt = (
  t: Pick<TimelineTransition, "start" | "seconds" | "style">,
  kind: TransitionBoundaryKind
): number =>
  kind === "in"
    ? t.start
    : isAudioTransition(t.style)
      ? t.start + t.seconds / 2
      : t.start + t.seconds;

/** Picker layout for the Transitions tab: the styles that blend the picture,
 * grouped by family, in display order. The sound styles are picked from the
 * Effects tab's Sound family, beside the other treatments on the sound. */
export const TRANSITION_STYLE_GROUPS: { label: string; ids: TransitionStyle[] }[] = [
  { label: "Fade", ids: ["crossfade", "dipblack", "dipwhite", "blur"] },
  { label: "Zoom", ids: ["crosszoom"] },
  { label: "Push", ids: ["pushleft", "pushright", "pushup", "pushdown"] },
  { label: "Wipe", ids: ["wipeleft", "wiperight", "wipeup", "wipedown"] },
  { label: "Shape", ids: ["circleopen", "circleclose", "splitopen", "splitclose"] },
];

/** Every style a bar can carry, whichever tab picks it. */
export const TRANSITION_STYLE_IDS: TransitionStyle[] = [
  ...TRANSITION_STYLE_GROUPS.flatMap((g) => g.ids),
  ...AUDIO_TRANSITION_STYLES,
];

export const TRANSITION_STYLE_LABELS: Record<TransitionStyle, string> = {
  crossfade: "Cross fade",
  crosszoom: "Cross zoom",
  dipblack: "Dip to black",
  dipwhite: "Dip to white",
  blur: "Blur",
  pushleft: "Push left",
  pushright: "Push right",
  pushup: "Push up",
  pushdown: "Push down",
  wipeleft: "Wipe left",
  wiperight: "Wipe right",
  wipeup: "Wipe up",
  wipedown: "Wipe down",
  circleopen: "Circle open",
  circleclose: "Circle close",
  splitopen: "Split open",
  splitclose: "Split close",
  audiocross: "Cross dissolve",
};

/** Peak scale the zoom transitions push into (preview and export). */
export const TRANSITION_ZOOM = 1.18;

/** A clip's own entrance/exit animation. The same style id serves both sides:
 * directional names describe the motion (slideleft moves the picture
 * leftward — entering from the right edge, or exiting off the left one).
 * Edge reveals (wipes, circles, splits) live on transitions only — as an
 * animation they'd duplicate the same visual. */
export type AnimStyle =
  | "fade"
  | "zoom"
  | "pop"
  | "slideleft"
  | "slideright"
  | "slideup"
  | "slidedown";

export interface ClipAnim {
  style: AnimStyle;
  /** Ramp length in timeline seconds, 0.1..TRANSITION_MAX. */
  seconds: number;
}

export const ANIM_STYLE_IDS: AnimStyle[] = [
  "fade",
  "zoom",
  "pop",
  "slideleft",
  "slideright",
  "slideup",
  "slidedown",
];

export const ANIM_STYLE_LABELS: Record<AnimStyle, string> = {
  fade: "Fade",
  zoom: "Zoom",
  pop: "Pop",
  slideleft: "Slide left",
  slideright: "Slide right",
  slideup: "Slide up",
  slidedown: "Slide down",
};

export const ANIM_DEFAULT_SECONDS = 0.5;

/** Animation styles an overlay-track clip can render natively (its segment
 * composites via alpha, so fade and zoom map onto the existing alpha/zoom
 * ramps; slides, wipes and pop would need per-frame overlay motion). Anything
 * else degrades to a fade on upper tracks. */
export function overlayAnimStyle(style: AnimStyle): "fade" | "zoom" {
  return style === "zoom" ? "zoom" : "fade";
}

/**
 * The entrance/exit a transition style becomes on an open edge.
 *
 * A cut has two pictures to blend; a clip's head or tail has one and nothing
 * against it, so the same drag reads as the clip arriving or leaving. The
 * directional styles keep their direction, the zooms keep their push, and the
 * shaped wipes — which need a second picture to reveal — come through as the
 * ramp closest to them. A sound style becomes nothing: it hands one clip's
 * sound to the next one's, and an open edge has no next one.
 */
const EDGE_ANIM: Record<TransitionStyle, AnimStyle | null> = {
  crossfade: "fade",
  dipblack: "fade",
  dipwhite: "fade",
  blur: "fade",
  crosszoom: "zoom",
  circleopen: "pop",
  circleclose: "pop",
  splitopen: "pop",
  splitclose: "pop",
  pushleft: "slideleft",
  pushright: "slideright",
  pushup: "slideup",
  pushdown: "slidedown",
  wipeleft: "slideleft",
  wiperight: "slideright",
  wipeup: "slideup",
  wipedown: "slidedown",
  audiocross: null,
};

const ANIM_TRANSITION: Record<AnimStyle, TransitionStyle> = {
  fade: "crossfade",
  zoom: "crosszoom",
  pop: "circleopen",
  slideleft: "pushleft",
  slideright: "pushright",
  slideup: "pushup",
  slidedown: "pushdown",
};

export const animStyleOfTransition = (style: TransitionStyle): AnimStyle | null =>
  EDGE_ANIM[style];

export const transitionStyleOfAnim = (style: AnimStyle): TransitionStyle =>
  ANIM_TRANSITION[style] ?? "crossfade";

// Looks (dual preview/export recipes) live in the effects kit; the ids and
// labels re-export here so doc-model consumers keep one import.
export { LOOK_IDS, LOOK_LABELS } from "@donkeycut/effects-kit";
export {
  GRADE_PRESET_CATEGORIES,
  GRADE_PRESET_IDS,
  GRADE_PRESETS,
} from "@donkeycut/effects-kit";
export type { GradePreset, GradePresetCategory } from "@donkeycut/effects-kit";
export type { LookStyle } from "@donkeycut/effects-kit";

/** Migrate docs saved before per-clip animations existed: the retired edge
 * transition styles (fadein/fadeout/zoomin/zoomout ramped one side of a hard
 * cut) become the equivalent clip animation — fadeout/zoomin on the leading
 * clip's own tail, fadein/zoomout on the following clip's head — and any
 * unknown style falls back to crossfade. Visuals are unchanged; layout never
 * moves (edge styles overlapped nothing, and animations don't either). */
export function migrateLegacyTransitions(clips: VideoClip[]): VideoClip[] {
  const LEGACY: Record<string, { side: "out" | "in"; style: AnimStyle }> = {
    fadeout: { side: "out", style: "fade" },
    zoomin: { side: "out", style: "zoom" },
    fadein: { side: "in", style: "fade" },
    zoomout: { side: "in", style: "zoom" },
  };
  const known = new Set<string>(TRANSITION_STYLE_IDS);
  if (
    !clips.some(
      (c) => c.transitionStyle && !known.has(c.transitionStyle as string)
    )
  ) {
    return clips;
  }
  const out = clips.map((c) => ({ ...c }));
  const byTrack = new Map<number, VideoClip[]>();
  for (const c of out) {
    const row = byTrack.get(c.track) ?? [];
    row.push(c);
    byTrack.set(c.track, row);
  }
  for (const row of byTrack.values()) {
    row.sort((a, b) => a.start - b.start);
    row.forEach((c, i) => {
      const raw = c.transitionStyle as string | undefined;
      if (!raw || known.has(raw)) return;
      const legacy = LEGACY[raw];
      const seconds = Math.min(c.transition ?? 0, TRANSITION_MAX);
      if (legacy && seconds > 0) {
        const target = legacy.side === "out" ? c : row[i + 1];
        if (target) {
          const key = legacy.side === "out" ? "animOut" : "animIn";
          target[key] ??= { style: legacy.style, seconds };
        }
      }
      // The edge ramp never overlapped, so the joint itself was a hard cut.
      c.transition = undefined;
      c.transitionStyle = undefined;
    });
  }
  return out;
}

/** A clip on the free-form soundtrack track. */
export interface AudioClip {
  id: string;
  assetId: string;
  start: number; // timeline position, seconds
  in: number;
  out: number;
  volume: number; // 0..3
  fadeIn?: number; // seconds, ramp up from the clip start
  fadeOut?: number; // seconds, ramp down into the clip end
  /** Equalizer, compressor, limiter on this clip's sound; absent = untouched. */
  sound?: ClipSound;
  /** Muted from the final mix but kept on the timeline (grayed). */
  hidden?: boolean;
  /** Playback rate, default 1 (absent). Set only when audio was detached from
   * a sped-up video clip, so it stays the same length and in sync with the
   * (now muted) picture. The timeline footprint is (out-in)/speed. */
  speed?: number;
  /** The video clip's speed curve, carried along on detach for the same reason. */
  speedCurve?: SpeedNode[];
  /** The video clip's reverse, carried along on detach so the sound keeps
   * running backward with the picture. */
  reverse?: boolean;
  /** Voiceover ducking: while this clip is audible, every other sound (clip
   * audio and other soundtrack clips) drops to this gain, 0..1. Absent = no
   * ducking. Ducking clips never duck each other. */
  duck?: number;
  /** Which audio track (row) this sits on, 0-based. Tracks are kept
   * contiguous: empty ones collapse and dragging past the last adds one. */
  lane?: number;
}

/**
 * A reusable timeline selection saved *by reference* — the source media plus
 * the edit that arranges it, never a flattened video. `layers`/`audio` point at
 * `media` by array index. Adding it to a project copies the media in and
 * re-materializes editable clips, overlays, and captions.
 */
export interface TemplateMedia {
  fileName: string;
  name: string;
  type: AssetType;
  duration: number;
  width?: number;
  height?: number;
}
export interface TemplateLayer {
  media: number; // index into `media`
  start: number;
  in: number;
  out: number;
  frame?: FrameRect;
  fit?: "fit" | "fill";
  /** The picture's own framing inside that box: zoom, crop pan, turn, fade. */
  zoom?: number;
  panX?: number;
  panY?: number;
  rotation?: number;
  opacity?: number;
  muted: boolean;
  speed?: number;
  speedCurve?: SpeedNode[];
  reverse?: boolean;
  sound?: ClipSound;
  track: number;
  /** Came from video track 0 — re-materializes as a timeline clip, not an
   * overlay, so a template stands up its own footage. */
  asClip?: boolean;
}
export interface TemplateAudio {
  media: number;
  start: number;
  in: number;
  out: number;
  volume: number;
  fadeIn?: number;
  fadeOut?: number;
  speed?: number;
  speedCurve?: SpeedNode[];
  reverse?: boolean;
  sound?: ClipSound;
  duck?: number;
  lane?: number;
}
export interface LibraryTemplate {
  id: string;
  name: string;
  addedAt: number;
  folderId?: string | null;
  duration: number;
  media: TemplateMedia[];
  layers: TemplateLayer[];
  audio: TemplateAudio[];
  texts: Overlay[];
  cues: SubtitleCue[];
  /** A saved sound treatment: a template carrying only this is a sound
   * preset (see soundPresets.ts), listed in the audio inspector and kept
   * off the template shelf. */
  sound?: ClipSound;
}
/** What the client sends to save a selection (media are project file names). */
export type TemplateSaveInput = Omit<LibraryTemplate, "id" | "addedAt">;

/** A font id: one of the base system set, a bundled Google family, or an
 * uploaded font ("asset:<assetId>"). Unknown ids fall back tolerantly. */
export type FontId = string;

export interface FontDef {
  id: FontId;
  label: string;
  stack: string;
}

/** The base system font set, available everywhere with no loading step. */
export const FONTS: FontDef[] = [
  { id: "sf", label: "SF Pro", stack: '-apple-system, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: "serif", label: "New York", stack: '"New York", ui-serif, Georgia, "Times New Roman", serif' },
  { id: "rounded", label: "Rounded", stack: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Helvetica Neue", sans-serif' },
  { id: "mono", label: "Mono", stack: 'ui-monospace, "SF Mono", Menlo, "Courier New", monospace' },
  { id: "impact", label: "Impact", stack: 'Impact, "Arial Black", "Helvetica Neue", sans-serif' },
];

// Fonts registered at runtime: the bundled Google families (build-time
// self-hosted via next/font) and per-project uploaded fonts. The page
// registers them before text renders; the engine imports this module but
// never rasterizes, so an empty registry there is fine.
const registeredFonts: FontDef[] = [];
const fontListeners = new Set<() => void>();

export function registerFonts(defs: FontDef[]): void {
  let added = false;
  for (const d of defs) {
    if (FONTS.some((f) => f.id === d.id) || registeredFonts.some((f) => f.id === d.id)) continue;
    registeredFonts.push(d);
    added = true;
  }
  if (added) for (const cb of fontListeners) cb();
}

/** Remove runtime fonts by id (a deleted font asset drops out of the menu). */
export function unregisterFonts(ids: string[]): void {
  let removed = false;
  for (const id of ids) {
    const i = registeredFonts.findIndex((f) => f.id === id);
    if (i >= 0) {
      registeredFonts.splice(i, 1);
      removed = true;
    }
  }
  if (removed) for (const cb of fontListeners) cb();
}

/** Every available font: the base set plus everything registered. */
export function allFonts(): FontDef[] {
  return [...FONTS, ...registeredFonts];
}

/** The registry id an uploaded font asset answers to. */
export const uploadedFontId = (assetId: string) => `asset:${assetId}`;

/** The asset behind a registry font id, or null for one of the built-in
 * families. The inverse of `uploadedFontId`, kept beside it so the shape of
 * the id is written down once. */
export const fontAssetId = (fontId: string): string | null =>
  fontId.startsWith("asset:") ? fontId.slice("asset:".length) : null;

/** Subscribe to registry changes (UI font menus re-render on registration). */
export function onFontsChanged(cb: () => void): () => void {
  fontListeners.add(cb);
  return () => fontListeners.delete(cb);
}

/** Whether the registry holds this id, which is to say the face behind it is
 * installed and will draw. Registration happens after the bytes install, so a
 * hit here means live text shows the typeface rather than the fallback face. */
export const hasFont = (id: string) =>
  FONTS.some((f) => f.id === id) || registeredFonts.some((f) => f.id === id);

/** CSS stack for a font id, tolerant of unknown ids (falls back to the first
 * font) so kit-typed elements and older docs always resolve to something. */
export const fontStack = (id: string) =>
  FONTS.find((f) => f.id === id)?.stack ??
  registeredFonts.find((f) => f.id === id)?.stack ??
  FONTS[0].stack;

/** Cut's text element: the kit's, with the font narrowed to the app's ids.
 * `kind` may be absent (docs written before shapes/stickers existed store
 * bare titles); the loader stamps `"text"` and the serializer strips it. */
export interface TextOverlay extends KitTextOverlay {
  font: FontId;
}

/** Every overlay element kind on the title lanes. Lane order is the single
 * z-order authority, whatever the kind. */
export type Overlay = TextOverlay | ShapeOverlay | StickerOverlay | EffectOverlay;

/** An element's place in the stack: lane 0 is the top row, and a bigger lane
 * number sits further under it. Every renderer stacks by this. */
export const laneOf = (o: { lane?: number }) => o.lane ?? 0;

export const isTextOverlay = (o: Overlay): o is TextOverlay => (o.kind ?? "text") === "text";
export const isShapeOverlay = (o: Overlay): o is ShapeOverlay => o.kind === "shape";
export const isStickerOverlay = (o: Overlay): o is StickerOverlay => o.kind === "sticker";
export const isEffectOverlay = (o: Overlay): o is EffectOverlay => o.kind === "effect";

/** The element rides the person matte in some direction. */
export const subjectMasked = (o: Overlay): boolean => o.mask?.kind === "subject";

/** The element sits behind the person (an inverted subject mask). */
export const behindSubjectOverlay = (o: Overlay): boolean => behindSubjectMask(o.mask);

/** The element shows only on the person (a plain subject mask). */
export const frontSubjectOverlay = (o: Overlay): boolean =>
  subjectMasked(o) && !behindSubjectOverlay(o);

/** Tolerant-load migration: documents written when behind-speaker was a
 * boolean load it as an inverted subject mask, so one mask model covers it
 * everywhere in memory and on save. Returns the same array when nothing
 * migrates (hosts compare documents by identity). */
export function migrateBehindSubject<T extends Overlay>(overlays: T[]): T[] {
  const legacy = (o: Overlay) =>
    isTextOverlay(o) && !!(o as { behindSubject?: boolean }).behindSubject;
  if (!overlays.some(legacy)) return overlays;
  return overlays.map((o) => {
    if (!legacy(o)) return o;
    const next = { ...o, mask: o.mask ?? { kind: "subject" as const, invert: true } };
    delete (next as { behindSubject?: boolean }).behindSubject;
    return next;
  });
}

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: "Rectangle",
  ellipse: "Ellipse",
  triangle: "Triangle",
  diamond: "Diamond",
  star: "Star",
  heart: "Heart",
  hexagon: "Hexagon",
  line: "Line",
  arrow: "Arrow",
};

/** A patch that may touch any kind's fields (never the discriminant). The
 * kit's shape, narrowed to the app's font ids. */
export type OverlayPatch = Partial<
  Omit<TextOverlay, "kind"> &
    Omit<ShapeOverlay, "kind"> &
    Omit<StickerOverlay, "kind"> &
    Omit<EffectOverlay, "kind">
>;

export { overlayKind, stampOverlayKinds, stripDefaultOverlayKinds };
export type {
  EffectOverlay,
  OverlayBase,
  OverlayKind,
  ShapeKind,
  ShapeOverlay,
  StickerOverlay,
  WordEffectId,
};

/** One subtitle caption, timed against the timeline (not the source files). */
export interface SubtitleCue {
  id: string;
  start: number; // timeline seconds
  end: number;
  text: string;
  /** Word timings from the transcriber. A same-word-count hand-edit keeps them
   * (text swapped in place); adding/removing a word drops them and splitting
   * falls back to proportional timing. */
  words?: { t0: number; t1: number; w: string }[];
  /** Which subtitle track (row) this belongs to, 0-based — one language per
   * track (e.g. English on 0, Korean on 1), up to MAX_SUBTITLE_LANES. Absent
   * = the first track. Tracks are managed in the panel, so lanes never
   * renumber under a cue. */
  lane?: number;
}

/** The most subtitle tracks (languages) a project can carry. */
export const MAX_SUBTITLE_LANES = 3;

/** Per-track subtitle settings; `SubtitlesBlock.tracks` indexes these by cue
 * lane. Everything else about captions (style, karaoke, visibility) stays
 * block-level and applies to every track. */
export interface SubtitleTrackMeta {
  /** Speech-recognition and display language for this track. */
  locale?: string;
  /** This track's captions stay on the timeline (grayed) but are excluded
   * from the played/exported picture; other tracks keep showing. */
  hidden?: boolean;
  /** Caption anchor as frame fractions; absent = the style's spot, stacked
   * upward per track so simultaneous languages never sit on each other. */
  x?: number;
  y?: number;
}

/** Caption look preset ids; the presets themselves live in lib/subtitles.ts. */
export type CaptionStyleId =
  | "clean"
  | "hook"
  | "punchy"
  | "minimal"
  | "editorial"
  | "typewriter"
  | "block"
  | "highlight"
  | "bubble"
  | "neon";

export interface SubtitlesBlock {
  cues: SubtitleCue[];
  /** Per-track settings, indexed by cue lane (absent entries = defaults).
   * The number of tracks is max(tracks.length, highest cue lane + 1, 1). */
  tracks?: SubtitleTrackMeta[];
  /** Render captions on the preview and burn them into exports. */
  showOnVideo: boolean;
  /** Show the cue track(s) on the timeline. */
  showOnTimeline: boolean;
  /** Legacy single-track language; per-track locales live in `tracks`. */
  locale?: string;
  generatedAt?: number;
  /** Caption look preset; absent = the plain "clean" subtitle style. */
  style?: CaptionStyleId;
  /** Caption font size (px at a 1080-wide frame); absent = the style
   * preset's size. Applies to every track. */
  size?: number;
  /** Caption font override; absent = the style preset's font. Picking a
   * style preset clears it, so the last choice — font or style — wins. */
  font?: FontId;
  /** Legacy caption anchor for the first track; dragging now writes the
   * per-track anchor in `tracks`. Read as the lane-0 fallback. */
  x?: number;
  y?: number;
  /** How many words one caption holds at a time; absent = the default read
   * (lib/cueChunk.ts). Changing it re-cuts every track on its own words. */
  wordsPerCue?: number;
  /** Word effects on: the caption plays word by word as it is spoken, in the
   * preview and the export burn-in. */
  wordHighlight?: boolean;
  /** Which word effect, overriding the caption style's own; absent = the
   * style's default. */
  accentMode?: WordEffectId;
  accentColor?: string;
  /** How far a word swells at its moment; absent = the effect's own. */
  accentScale?: number;
  /** The opacity a word wears off its moment; absent = the effect's own. */
  accentDim?: number;
}

export const emptySubtitles = (): SubtitlesBlock => ({
  cues: [],
  showOnVideo: true,
  showOnTimeline: true,
});

export type Selection =
  | { kind: "clip"; id: string }
  | { kind: "audio"; id: string }
  | { kind: "overlay"; id: string }
  | { kind: "cue"; id: string }
  | { kind: "transition"; id: string }
  | null;

export interface ClipSpan {
  clip: VideoClip;
  asset: MediaAsset;
  start: number; // timeline start
  len: number; // own timeline footprint (source length / speed)
  /** Blend length into the next span, in timeline seconds: the window
   * `[end - transitionOut, end]` where the next clip's first frame arrives
   * over this clip's live tail. Spans never intersect — the next one starts
   * exactly at this one's end, and plays from its head there. */
  transitionOut: number;
  /** Half the cross dissolve at this span's tail, in timeline seconds: the
   * handover runs this long either side of the cut, ramping equal-power from
   * this clip to the next while the picture cuts. Zero unless the transition
   * at the cut is one of the sound styles, and never set at the same time as
   * `transitionOut` — a handover blends the picture or the sound. */
  soundOut: number;
  /** Seconds of source past this span's out point that its sound keeps
   * playing, so the outgoing half of the cross dissolve at its tail has
   * something to cross with. Zero when the clip is trimmed to the end of its
   * source: with no handle to reach into, its side of the handover simply
   * stops at the cut. */
  soundAhead: number;
  /** Seconds of source before this span's in point that its sound starts, for
   * the incoming half of the cross dissolve at the cut behind it. Zero when
   * the clip starts at its source's head. */
  soundBack: number;
}

/** The document persisted as project.json inside each project folder. */
/** Which optional surfaces a project share exposes to viewers. Playback
 * (preview + timeline) is always shared; these opt the rest in. */
export interface ShareFeatures {
  chat: boolean;
  media: boolean;
  genai: boolean;
  subtitles: boolean;
  details: boolean;
}

/** The editor's side-panel tabs ("publish" shows as Details). */
export type SidePanelTab =
  | "media"
  | "elements"
  | "effects"
  | "transitions"
  | "video"
  | "image"
  | "audio"
  | "subtitles"
  | "publish";

export const SIDE_PANEL_TABS: SidePanelTab[] = [
  "media",
  "elements",
  "effects",
  "transitions",
  "video",
  "image",
  "audio",
  "subtitles",
  "publish",
];

export interface ProjectDoc {
  version: 1;
  /** The project's stable API id. On the local engine the folder is named
   * after the project and follows renames, so the id lives in the doc; the
   * server stamps it on every write. */
  id?: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  assets: StoredAsset[];
  /** Every video clip, on any track (the `track` field places it). Older docs
   * split these into track-0 `clips` plus an `overlayClips` array; the loader
   * folds that shape into this one. */
  clips: VideoClip[];
  audioClips: AudioClip[];
  /** Transition bars, free objects on the transitions row. Older docs stored
   * transitions and edge animations as clip fields; the loader converts those
   * into bars once. */
  transitions?: TimelineTransition[];
  /** Legacy: video clips on tracks other than 0, kept a separate array in older
   * docs. Read on open and merged into `clips`; new saves never write it. */
  overlayClips?: VideoClip[];
  overlays: Overlay[];
  /** Output frame; absent in older projects (which are all 9:16). */
  aspect?: Aspect;
  /** Whole-video fades, seconds: in from black at the start, out to black at
   * the end. Applied to the final picture and mix (titles, captions, and
   * soundtrack fade together), so they survive clip reordering. */
  fadeIn?: number;
  fadeOut?: number;
  /** The color of the frame itself, behind everything: what a text-and-graphics
   * cut plays over, what letterboxes a fitted clip, and what fills a gap in the
   * timeline. Hex; absent = `DEFAULT_BACKGROUND`. */
  background?: string;
  /** Auto-generated (then hand-edited) subtitles. */
  subtitles?: SubtitlesBlock;
  /** Legacy per-project view metadata — view state now lives in IndexedDB;
   * still read on open so older project.json files keep their zoom. */
  ui?: {
    pxPerSec?: number;
  };
  /** TikTok publishing metadata, prepared here and copied over on upload. */
  publish?: {
    caption?: string;
    tags?: string;
    soundTitle?: string;
    handle?: string;
  };
  /** Free-form notes for the maker: published date, source links, reminders. */
  notes?: {
    text?: string;
    publishedAt?: string; // ISO date (yyyy-mm-dd)
    links?: string[];
  };
  /** Templates saved in this project (their media reference project files by
   * name). Adding one to the shared Library copies its media out. */
  templates?: LibraryTemplate[];
  /** The Media panel's folders; assets file into them via their `folderId`. */
  mediaFolders?: MediaFolder[];
  /** Which project folder this belongs to (null/absent = ungrouped). */
  folderId?: string | null;
  /** In-progress or finished brief-to-video run (genvideo). Persisted so a
   * multi-minute generation survives reload and resumes; the plan is the single
   * source of truth for the run (see lib/genvideo/types.ts). On the save wire,
   * null means "clear it" (absent means keep); at rest it is never null. */
  genvideo?: VideoProject | null;
  /** Chat-launched video renders, running and settled — see RenderRecord. */
  renders?: RenderRecord[];
  /** How the project presents itself the first time a browser opens it: the
   * editor reads this and applies it once, then the layout is the user's own.
   * Seeded template docs (public/cut-starter) carry it; absent means an
   * ordinary open. */
  firstOpen?: {
    /** Side-panel tab to show; null folds the panel to its icon rail. */
    sidePanel?: SidePanelTab | null;
    /** Open the chat panel: `true` on a fresh empty thread, a thread id on
     * that saved thread ("newest", or any id no saved thread carries,
     * resolves to the project's most recent one). */
    chat?: boolean | string;
    /** Start playback (held until the welcome slides hand over). */
    play?: boolean;
  };
}

/** A chat-launched video render, mirrored into the doc as it runs and settles.
 * The browser-local job store covers only the machine that ran the render;
 * this record is what lets the chat's render card show the same outcome on
 * every browser and machine. */
export interface RenderRecord {
  /** The GenerateJob id the chat message's tool output points at. */
  id: string;
  chatId: string;
  prompt: string;
  startedAt: number;
  status: "running" | "done" | "error";
  error?: string;
  /** The project asset the finished render landed as. */
  assetId?: string;
}

/** A named group of projects on the home screen. Folders file into folders
 * through `parentId`; null (or absent, on an index from before nesting) is
 * the top level. */
export interface ProjectFolder {
  id: string;
  name: string;
  parentId?: string | null;
  createdAt: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  duration: number;
  clipCount: number;
  assetCount: number;
  /** Media file used for the card poster / hover fallback. */
  previewFile?: string;
  /** The poster file is a still image, so the card renders it as an <img>. */
  previewIsImage?: boolean;
  /** Source time (seconds) of the poster frame — the first clip's trim-in. */
  previewStart?: number;
  /** Whether a rendered proxy of the edit exists to play on hover. */
  hasPreview?: boolean;
  /** Output frame ratio, so the home card takes the project's shape.
   * Absent in older projects (which are all 9:16). */
  aspect?: Aspect;
  /** Folder this project is filed under (null = ungrouped). */
  folderId?: string | null;
  /** Total bytes on disk (media + exports + proxy), for cleanup decisions. */
  sizeBytes?: number;
}

/** A project media file's URL. Work that outlives navigation (a generation
 * landing after the user left the project) pins the backend it started on and
 * must pass it: resolving the ambient backend here instead would address a
 * cloud project's bytes at the local engine, or the reverse, and the asset
 * would carry that wrong address for as long as it lives. */
export const mediaUrl = (projectId: string, fileName: string, backend?: CutBackend) =>
  (backend ?? getBackend()).url(
    `/api/cut/projects/${projectId}/media/${encodeURIComponent(fileName)}`
  );

/** A filename-safe slug from a display name: lowercased, every run of
 * non-alphanumerics collapsed to a hyphen, trimmed and capped, with `fallback`
 * when nothing survives. Shared by every generated-media filename (music,
 * voice, video) so the rule lives in one place. */
export const mediaSlug = (name: string, fallback: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || fallback;
