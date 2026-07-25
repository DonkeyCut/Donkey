import { apiUrl } from "./backend";
import type { VideoProject } from "./genvideo/types";

export type AssetType = "video" | "audio" | "image";

/** Default on-timeline length (seconds) a still image occupies when placed —
 * an image has no intrinsic duration, so the clip carries this as its `out`. */
export const IMAGE_CLIP_SECONDS = 8;

/** Project output frame. Vertical (TikTok/Reels) or widescreen (YouTube). */
export type Aspect = "9:16" | "16:9";

export const FRAME: Record<Aspect, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "16:9": { w: 1920, h: 1080 },
};

export const ASPECT_LABEL: Record<Aspect, string> = {
  "9:16": "Vertical · 9:16",
  "16:9": "Widescreen · 16:9",
};

/** Asset fields persisted in project.json. */
export interface StoredAsset {
  id: string;
  fileName: string; // file inside the project's media/ folder
  name: string; // original display name
  type: AssetType;
  duration: number; // seconds
  width?: number;
  height?: number;
  /** How this asset entered the project. Absent = the user imported it (drag,
   * drop, or upload), so it belongs in the Media panel. Any value marks media
   * Cut created or fetched — it lives where it was made (the timeline, a
   * generation panel, or an AI chat card) and is kept out of the Media panel. */
  origin?: "voiceover" | "generated" | "recording" | "stock" | "freeze" | "chat";
  /** BCP-47 of the audio's spoken language, when known (stamped on voiceovers
   * at synthesis) — what transcription should run its recognizer in. */
  language?: string;
  /** For origin "chat": the chat thread that made it. Deleting that thread
   * deletes the assets it still owns (see chatAssets.ts). */
  chatId?: string;
}

/** Runtime asset: stored fields plus derived/browser-only data. */
export interface MediaAsset extends StoredAsset {
  url: string; // /api/cut/projects/<id>/media/<fileName>
  /** Filmstrip frames (video only), evenly spaced every `thumbStep` seconds. */
  thumbs?: string[];
  thumbStep?: number;
  /** Normalized waveform peaks 0..1 (audio only). */
  peaks?: number[];
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

/** A clip's effective region: its own `frame`, or the full frame if unset. */
export function rectOf(clip: { frame?: FrameRect }): FrameRect {
  return clip.frame ?? FULL_FRAME;
}

/** Whether a region covers the whole frame (so it needs no special layout). */
export function isFullRect(r: FrameRect): boolean {
  return r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999;
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
  /** Gain on the clip's own audio, 0..1.5; absent = 1 (unchanged). */
  volume?: number;
  /** How the clip meets its region: letterboxed ("fit", default) or scaled to
   * cover it ("fill", cropping the overflow). */
  fit?: "fit" | "fill";
  /** The region of the frame this clip occupies; absent = full frame. Lets a
   * clip share the frame with another track (e.g. a split-screen half) or float
   * small over it (picture-in-picture). */
  frame?: FrameRect;
  /** Crop-window pan in fill mode, -1..1 per axis (0 = centered): which part
   * of the oversized video stays visible. */
  panX?: number;
  panY?: number;
  /** Playback rate, default 1 (absent). The source (out-in) seconds play in
   * (out-in)/speed timeline seconds, so >1 is faster and shorter. */
  speed?: number;
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
}

/** Per-clip manual color adjustments. Integer sliders, 0 = neutral; the whole
 * field is absent when every value is 0, so untouched clips carry nothing. */
export interface ColorGrade {
  brightness?: number; // -50..50
  contrast?: number; // -50..50
  saturation?: number; // -50..50
  exposure?: number; // -50..50 (±1 EV)
  temperature?: number; // -50..50, positive = warm
  hue?: number; // -180..180 degrees
}

/** Slider range for every grade parameter except hue. */
export const GRADE_MAX = 50;
export const GRADE_HUE_MAX = 180;

/** Speed slider range. Typed entry and tools may go beyond it; SPEED_FLOOR is
 * the only hard bound, keeping rates positive so length math stays finite. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
export const SPEED_FLOOR = 0.05;
/** Longest transition offered; also clamps against the clips it joins. */
export const TRANSITION_MAX = 2;

/** Effective whole-video fade length: the stored seconds, capped at half the
 * project so a fade-in and fade-out never overlap. The one clamp preview and
 * export both apply, so a short project fades identically in the editor and the
 * rendered file. */
export function projectFadeSeconds(fade: number | undefined, duration: number): number {
  return Math.max(0, Math.min(fade ?? 0, duration / 2));
}

/** How a clip hands off to the next one. Every style is a physical overlap:
 * the two clips run together for the transition length and the cut shortens
 * by it. Directional names describe the motion (pushleft pushes the frame
 * leftward; wipeleft's reveal edge travels leftward). */
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
  | "splitclose";

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
};

/** Picker layout: styles grouped by family, in display order. */
export const TRANSITION_STYLE_GROUPS: { label: string; ids: TransitionStyle[] }[] = [
  { label: "Fade", ids: ["crossfade", "dipblack", "dipwhite", "blur"] },
  { label: "Zoom", ids: ["crosszoom"] },
  { label: "Push", ids: ["pushleft", "pushright", "pushup", "pushdown"] },
  { label: "Wipe", ids: ["wipeleft", "wiperight", "wipeup", "wipedown"] },
  { label: "Shape", ids: ["circleopen", "circleclose", "splitopen", "splitclose"] },
];

export const TRANSITION_STYLE_IDS: TransitionStyle[] = TRANSITION_STYLE_GROUPS.flatMap(
  (g) => g.ids
);

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

/** Preset filter looks: a named color/effect treatment baked over a clip's
 * picture in both preview and export. */
export type LookStyle =
  | "vintage"
  | "vhs"
  | "horror"
  | "halation"
  | "tech"
  | "noir"
  | "grain"
  | "pastel"
  | "blockbuster"
  | "dreamy";

export const LOOK_IDS: LookStyle[] = [
  "vintage",
  "vhs",
  "horror",
  "halation",
  "tech",
  "noir",
  "grain",
  "pastel",
  "blockbuster",
  "dreamy",
];

export const LOOK_LABELS: Record<LookStyle, string> = {
  vintage: "Vintage",
  vhs: "VHS",
  horror: "Analogue horror",
  halation: "Halation",
  tech: "Modern tech",
  noir: "Noir",
  grain: "Film grain",
  pastel: "Pastel",
  blockbuster: "Blockbuster",
  dreamy: "Dreamy",
};

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
  volume: number; // 0..1.5
  fadeIn?: number; // seconds, ramp up from the clip start
  fadeOut?: number; // seconds, ramp down into the clip end
  /** Muted from the final mix but kept on the timeline (grayed). */
  hidden?: boolean;
  /** Playback rate, default 1 (absent). Set only when audio was detached from
   * a sped-up video clip, so it stays the same length and in sync with the
   * (now muted) picture. The timeline footprint is (out-in)/speed. */
  speed?: number;
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
  muted: boolean;
  speed?: number;
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
  texts: TextOverlay[];
  cues: SubtitleCue[];
}
/** What the client sends to save a selection (media are project file names). */
export type TemplateSaveInput = Omit<LibraryTemplate, "id" | "addedAt">;

export type FontId = "sf" | "serif" | "rounded" | "mono" | "impact";

export interface FontDef {
  id: FontId;
  label: string;
  stack: string;
}

export const FONTS: FontDef[] = [
  { id: "sf", label: "SF Pro", stack: '-apple-system, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: "serif", label: "New York", stack: '"New York", ui-serif, Georgia, "Times New Roman", serif' },
  { id: "rounded", label: "Rounded", stack: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Helvetica Neue", sans-serif' },
  { id: "mono", label: "Mono", stack: 'ui-monospace, "SF Mono", Menlo, "Courier New", monospace' },
  { id: "impact", label: "Impact", stack: 'Impact, "Arial Black", "Helvetica Neue", sans-serif' },
];

export const fontStack = (id: FontId) =>
  FONTS.find((f) => f.id === id)?.stack ?? FONTS[0].stack;

export interface TextOverlay {
  id: string;
  text: string;
  start: number; // timeline seconds
  end: number;
  x: number; // center, fraction of frame width 0..1
  y: number; // center, fraction of frame height 0..1
  size: number; // px at a 1080-wide frame
  font: FontId;
  weight: 400 | 700;
  color: string;
  shadow: boolean;
  plate: boolean; // rounded plate behind the text
  plateRadius?: number; // plate corner radius in em (default PLATE_RADIUS)
  plateColor?: string; // plate fill color (default black)
  plateOpacity?: number; // plate fill opacity 0..1 (default PLATE_OPACITY)
  /** Which title track (row) this sits on, 0-based. Tracks are kept
   * contiguous: empty ones collapse and dragging past the last adds one. */
  lane?: number;
  /** Karaoke burn-in: index of the display word (whitespace-split across all
   * lines) drawn per the accent treatment — recolored, underlined, or on an
   * accent box with a contrast text color. */
  highlightWord?: number;
  highlightColor?: string;
  highlightMode?: WordAccentMode;
  highlightText?: string;
}

/** How the spoken word lights up in karaoke mode: accent color only, accent
 * color plus underline, or an accent box behind the word. */
export type WordAccentMode = "color" | "underline" | "box";

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
  /** Karaoke mode: each word lights up as it is spoken, in the preview and
   * the export burn-in. */
  wordHighlight?: boolean;
  /** Word treatment overrides; absent = the caption style's defaults. */
  accentMode?: WordAccentMode;
  accentColor?: string;
}

export const emptySubtitles = (): SubtitlesBlock => ({
  cues: [],
  showOnVideo: true,
  showOnTimeline: true,
});

export type Selection =
  | { kind: "clip"; id: string }
  | { kind: "audio"; id: string }
  | { kind: "text"; id: string }
  | { kind: "cue"; id: string }
  | null;

export interface ClipSpan {
  clip: VideoClip;
  asset: MediaAsset;
  start: number; // timeline start
  len: number; // own timeline footprint (source length / speed)
  /** Cross-dissolve overlap into the next span, in timeline seconds. The next
   * span's start already sits `transitionOut` earlier, so the two intersect. */
  transitionOut: number;
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

export interface ProjectDoc {
  version: 1;
  name: string;
  createdAt: number;
  updatedAt: number;
  assets: StoredAsset[];
  /** Every video clip, on any track (the `track` field places it). Older docs
   * split these into track-0 `clips` plus an `overlayClips` array; the loader
   * folds that shape into this one. */
  clips: VideoClip[];
  audioClips: AudioClip[];
  /** Legacy: video clips on tracks other than 0, kept a separate array in older
   * docs. Read on open and merged into `clips`; new saves never write it. */
  overlayClips?: VideoClip[];
  overlays: TextOverlay[];
  /** Output frame; absent in older projects (which are all 9:16). */
  aspect?: Aspect;
  /** Whole-video fades, seconds: in from black at the start, out to black at
   * the end. Applied to the final picture and mix (titles, captions, and
   * soundtrack fade together), so they survive clip reordering. */
  fadeIn?: number;
  fadeOut?: number;
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
  /** Which project folder this belongs to (null/absent = ungrouped). */
  folderId?: string | null;
  /** In-progress or finished brief-to-video run (genvideo). Persisted so a
   * multi-minute generation survives reload and resumes; the plan is the single
   * source of truth for the run (see lib/genvideo/types.ts). On the save wire,
   * null means "clear it" (absent means keep); at rest it is never null. */
  genvideo?: VideoProject | null;
  /** Chat-launched video renders, running and settled — see RenderRecord. */
  renders?: RenderRecord[];
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

/** A named group of projects on the home screen. */
export interface ProjectFolder {
  id: string;
  name: string;
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
  /** Folder this project is filed under (null = ungrouped). */
  folderId?: string | null;
  /** Total bytes on disk (media + exports + proxy), for cleanup decisions. */
  sizeBytes?: number;
}

export const mediaUrl = (projectId: string, fileName: string) =>
  apiUrl(`/api/cut/projects/${projectId}/media/${encodeURIComponent(fileName)}`);

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
