/**
 * Time-ranged visual effects as first-class overlay elements — the placeable
 * cousins of looks: where a look grades one clip, an effect is a moment on
 * the timeline that filters whatever video is under it. Each effect is one
 * recipe with two renderers driven by the same `amount` knob: a canvas pass
 * for the preview/in-tab render, and an ffmpeg fragment (LGPL-safe filters
 * only: eq, gblur, noise, vignette, rgbashift, scale/crop, overlay) for the
 * server pipeline.
 */

import type { OverlayBase } from "./types";
import { AUDIO_EFFECT_IDS, AUDIO_EFFECT_LABELS, type AudioEffectId } from "./audioFx";
import { LOOK_LABELS, lookCssFilter, lookFilterLines, lookPost, type LookStyle } from "./looks";

/** The effects that treat the picture. */
export type VisualEffectId =
  | "zoom"
  | "grain"
  | "vhs"
  | "glitch"
  | "blur"
  | "vignette"
  | "lightleak"
  | "flash"
  | "shake"
  /** The graded looks, placeable like any other effect. */
  | "vintage"
  | "horror"
  | "halation"
  | "tech"
  | "noir"
  | "pastel"
  | "blockbuster"
  | "dreamy";

/** Every effect an element can carry: the picture treatments above and the
 * audio treatments in `audioFx.ts`. One element kind covers both — an effect
 * is a stretch of timeline that treats what runs under it, and which of the
 * two it treats is the id. */
export type EffectId = VisualEffectId | AudioEffectId;

export interface EffectOverlay extends OverlayBase {
  kind: "effect";
  effect: EffectId;
  /** Strength 0..1; absent = 0.5. */
  amount?: number;
  /** The point of the frame the zoom holds on, in frame fractions; absent =
   * the middle. */
  focus?: { x: number; y: number };
  /** Seconds a zoom takes to reach its depth; absent = `ZOOM_RAMP_DEFAULT`,
   * 0 = there on the first frame. */
  ramp?: number;
  /** Reserved: a sub-frame region (fractions); absent = full frame. */
  region?: { w: number; h: number };
}

/** The picture treatments, in picker order. The audio ones are their own list
 * (`AUDIO_EFFECT_IDS`); `ALL_EFFECT_IDS` is both. */
export const EFFECT_IDS: VisualEffectId[] = [
  "zoom",
  "grain",
  "vhs",
  "glitch",
  "blur",
  "vignette",
  "lightleak",
  "flash",
  "shake",
  "vintage",
  "horror",
  "halation",
  "tech",
  "noir",
  "pastel",
  "blockbuster",
  "dreamy",
];

/**
 * The effects whose recipe is a graded look. A look was once a property of one
 * clip; as an effect it is a stretch of the timeline like any other, so it can
 * cover a clip, part of one, or a run of them.
 *
 * `vhs` and `grain` are not here — they are effects in their own right above,
 * with tearing and moving grain the grades never had.
 */
export const LOOK_EFFECTS: LookStyle[] = [
  "vintage",
  "horror",
  "halation",
  "tech",
  "noir",
  "pastel",
  "blockbuster",
  "dreamy",
];

const lookOf = (effect: string): LookStyle | null =>
  (LOOK_EFFECTS as string[]).includes(effect) ? (effect as LookStyle) : null;

export const ALL_EFFECT_IDS: EffectId[] = [...EFFECT_IDS, ...AUDIO_EFFECT_IDS];

export const EFFECT_LABELS: Record<EffectId, string> = {
  ...AUDIO_EFFECT_LABELS,
  zoom: "Zoom",
  grain: "Film grain",
  vhs: "VHS",
  glitch: "Glitch",
  blur: "Blur",
  vignette: "Vignette",
  lightleak: "Light leak",
  flash: "Flash",
  shake: "Shake",
  vintage: LOOK_LABELS.vintage,
  horror: LOOK_LABELS.horror,
  halation: LOOK_LABELS.halation,
  tech: LOOK_LABELS.tech,
  noir: LOOK_LABELS.noir,
  pastel: LOOK_LABELS.pastel,
  blockbuster: LOOK_LABELS.blockbuster,
  dreamy: LOOK_LABELS.dreamy,
};

const clampAmount = (k: number | undefined) => Math.max(0.05, Math.min(1, k ?? 0.5));
const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();

/** The CSS background of a leak's bloom at (x, y) frame fractions — the DOM
 * twin of the canvas pass's radial gradient; screen-blend it at the leak's
 * alpha. */
export const leakGradient = (x: number, y: number) =>
  `radial-gradient(circle at ${(x * 100).toFixed(1)}% ${(y * 100).toFixed(1)}%, ` +
  `rgba(255,190,120,0.9) 0%, rgba(255,150,60,0.5) 30%, rgba(255,120,40,0) 58%)`;

/** The bloom's plain-blend share of the leak alpha. Screen alone dies on a
 * bright frame, so every renderer lays the gradient down twice: screen at the
 * leak's alpha, plain at this fraction of it. */
export const LEAK_TINT = 0.5;

/** One band of leaked light: a soft tilted streak, described on the CSS
 * gradient axis so every renderer draws the same band. */
export interface LeakStreak {
  /** Tilt in CSS gradient degrees. */
  angle: number;
  /** The band center's position along the gradient axis, 0..1. */
  p: number;
  /** The band's half-width as a fraction of the axis. */
  w: number;
  alpha: number;
}

/** The leak's streak family: each band's tilt, width, sweep and pulse. The
 * amount slider brings them in — one band low, all of them near the top —
 * and each sweeps across the frame and flares on its own clock. */
export const STREAK_BANDS = [
  { angle: 62, w: 0.045, base: 0.3, drift: 0.22, sweep: 0.5, pulse: 0.9, phase: 0 },
  { angle: 74, w: 0.1, base: 0.62, drift: 0.24, sweep: 0.33, pulse: 0.6, phase: 2.1 },
  { angle: 57, w: 0.028, base: 0.44, drift: 0.3, sweep: 0.75, pulse: 1.2, phase: 4.2 },
] as const;

export const streakCount = (k: number) =>
  Math.max(1, Math.min(STREAK_BANDS.length, Math.round(3 * k)));

/** How bright the bands run at amount `k`. A floor keeps a streak plainly
 * visible at the low end of the slider — the amount chooses how many bands
 * and how hard they flare, never whether the effect shows at all. */
export const streakGain = (k: number) => 0.45 + 0.55 * k;

function leakStreaksAt(tLocal: number, k: number): LeakStreak[] {
  return STREAK_BANDS.slice(0, streakCount(k)).map((b) => ({
    angle: b.angle,
    p: b.base + b.drift * Math.sin(tLocal * b.sweep + b.phase),
    w: b.w,
    alpha: (0.55 + 0.3 * Math.sin(tLocal * b.pulse + b.phase * 1.7)) * streakGain(k),
  }));
}

/** The CSS background of one streak — the DOM twin of the canvas pass's
 * linear gradient; blend it the same two ways as the bloom. */
export const streakGradient = (s: LeakStreak) =>
  `linear-gradient(${s.angle}deg, rgba(255,200,140,0) ${((s.p - 2 * s.w) * 100).toFixed(1)}%, ` +
  `rgba(255,200,140,0.9) ${(s.p * 100).toFixed(1)}%, ` +
  `rgba(255,200,140,0) ${((s.p + 2 * s.w) * 100).toFixed(1)}%)`;

/** What one effect asks the preview canvas to do at `tLocal` seconds in. */
export interface EffectPreviewState {
  /** ctx.filter for a self-redraw of the frame; "" = none. */
  cssFilter: string;
  /** Animated noise-tile alpha 0..1. */
  grain?: number;
  /** Radial corner darkening 0..1. */
  vignette?: number;
  /** Flat washes over the picture. */
  washes?: { color: string; alpha: number; mode: GlobalCompositeOperation }[];
  /** A light leak's bloom: a warm radial glow centered at (x, y) in frame
   * fractions, screen-blended over the picture at `alpha`, with the streak
   * bands sweeping over it. */
  leak?: { x: number; y: number; alpha: number; streaks: LeakStreak[] };
  /** Chroma ghosting: tinted copies offset by this frame-width fraction. */
  ghostFrac?: number;
  /** Whole-frame white flash alpha 0..1. */
  flash?: number;
  /** Frame offset in design px (1080 short side). */
  dx?: number;
  dy?: number;
  /** Frame scale: a shake's slight overscale to keep its edges covered, a
   * zoom's push in. */
  zoom?: number;
  /** The point `zoom` scales about, in frame fractions; absent = the middle. */
  origin?: { x: number; y: number };
  /** Self-copy glow: blur radius as a fraction of frame height, blended back
   * over the picture; `bright` isolates highlights first (halation). */
  glow?: { blurFrac: number; alpha: number; mode: "screen" | "lighten"; bright?: boolean };
}

/** A host-registered effect recipe: the same dual-renderer shape the
 * built-ins use. */
export interface EffectRecipe {
  previewState(amount: number | undefined, tLocal: number): EffectPreviewState;
  filterLines(
    inLabel: string,
    outLabel: string,
    amount: number | undefined,
    start: number,
    end: number,
    width: number,
    height: number,
    tag: string
  ): string[] | null;
}

const customEffects = new Map<string, EffectRecipe>();

/** Register a custom effect (or replace a built-in's recipe). */
export function defineEffect(id: string, recipe: EffectRecipe): void {
  customEffects.set(id, recipe);
}

/** Shake travel at full amount, in design px (1080 short side). Both recipes
 * read it so the export matches the preview. */
const SHAKE_AMP = 22;

/** How far a zoom pushes in at full depth. The picture renders at this much
 * more than frame size and is cropped back around the focus point. */
const ZOOM_RANGE = 0.6;

/**
 * The depths a zoom comes in. A zoom is a choice of how close to get, so it is
 * picked from named depths; the amount each stands for is the same 0..1 knob
 * every other effect carries.
 */
export const ZOOM_LEVELS: { id: string; label: string; amount: number }[] = [
  { id: "shallow", label: "Shallow", amount: 0.25 },
  { id: "moderate", label: "Moderate", amount: 0.5 },
  { id: "deep", label: "Deep", amount: 1 },
];

/** The frame scale a zoom of this amount renders at. */
export const zoomScale = (amount: number | undefined) => 1 + ZOOM_RANGE * clampAmount(amount);

/** How long a zoom may take to reach its depth, in seconds. Zero is a cut
 * straight to the close shot. */
export const ZOOM_RAMP_MAX = 4;
/** Quick enough to read as a move, slow enough that the smoothstep eases show. */
export const ZOOM_RAMP_DEFAULT = 0.5;

export const zoomRampOf = (ramp: number | undefined) =>
  Math.max(0, Math.min(ZOOM_RAMP_MAX, ramp ?? ZOOM_RAMP_DEFAULT));

/**
 * How far into its push in a zoom is at `tLocal`: the camera moves in over the
 * ramp, holds, and pulls back out over the same ramp before the element ends.
 * The curve eases at both ends, so the move starts and settles rather than
 * snapping to a constant speed. Without `dur` the zoom only comes in.
 */
export const zoomProgress = (tLocal: number, ramp: number | undefined, dur?: number) => {
  const r = zoomRampOf(ramp);
  if (r <= 0) return 1;
  const inP = Math.max(0, Math.min(1, tLocal / r));
  // An element shorter than two ramps never reaches full depth — the in and
  // out meet partway, which is the same in every renderer.
  const outP = dur === undefined ? 1 : Math.max(0, Math.min(1, (dur - tLocal) / r));
  const p = Math.min(inP, outP);
  return p * p * (3 - 2 * p);
};

/** The focus a zoom holds on, defaulted to the middle of the frame. */
const focusOf = (focus?: { x: number; y: number }) => ({
  x: Math.max(0, Math.min(1, focus?.x ?? 0.5)),
  y: Math.max(0, Math.min(1, focus?.y ?? 0.5)),
});

/** The preview recipe, sampled at a moment — deterministic in `tLocal`, so
 * the in-tab export replays exactly what the live preview showed. */
export function effectPreviewState(
  effect: string,
  amount: number | undefined,
  tLocal: number,
  focus?: { x: number; y: number },
  ramp?: number,
  /** The element's own length, so a zoom knows where to pull back out. */
  dur?: number
): EffectPreviewState {
  const custom = customEffects.get(effect);
  if (custom) return custom.previewState(amount, tLocal);
  const k = clampAmount(amount);
  const look = lookOf(effect);
  if (look) {
    const post = lookPost(look, k);
    return {
      cssFilter: lookCssFilter(look, k),
      grain: post?.grain,
      vignette: post?.vignette,
      washes: post?.washes,
      ghostFrac: post?.ghost?.shiftFrac,
      glow: post?.glow,
    };
  }
  switch (effect as VisualEffectId) {
    case "zoom":
      // A push in on one part of the picture: the frame renders larger and is
      // cropped back to size around the focus, which stays where it is. The
      // scale rides in over the ramp, so the shot moves in rather than cuts.
      return {
        cssFilter: "",
        zoom: 1 + (zoomScale(k) - 1) * zoomProgress(tLocal, ramp, dur),
        origin: focusOf(focus),
      };
    case "grain":
      return { cssFilter: "", grain: 0.25 + 0.55 * k };
    case "vhs":
      return {
        cssFilter: `saturate(${fmt(1 - 0.35 * k)}) contrast(${fmt(1 - 0.05 * k)}) blur(${fmt(0.6 * k)}px)`,
        grain: 0.25 * k,
        ghostFrac: 0.004 * k,
      };
    case "glitch": {
      // The shift jumps between quantized offsets a few times a second, so it
      // reads as digital tearing rather than a steady fringe.
      const step = Math.floor(tLocal * 9);
      const jitter = ((step * 7919) % 5) - 2; // -2..2, deterministic
      return { cssFilter: "", ghostFrac: (0.004 + 0.003 * jitter) * k, grain: 0.12 * k };
    }
    case "blur":
      return { cssFilter: `blur(${fmt(10 * k)}px)` };
    case "vignette":
      return { cssFilter: "", vignette: 0.75 * k };
    case "lightleak":
      return {
        // The frame keeps its own color: the cast stays faint so the streaks
        // and the corner bloom carry the effect by contrast.
        cssFilter: `saturate(${fmt(1 + 0.06 * k)})`,
        washes: [{ color: "#ff9a3c", alpha: 0.06 * k, mode: "soft-light" }],
        // The bloom hugs its corner and breathes a little, the way a leak
        // moves as the camera does.
        leak: {
          x: 0.16 + 0.14 * Math.sin(tLocal * 0.9),
          y: 0.2 + 0.11 * Math.cos(tLocal * 0.6),
          alpha: (0.55 + 0.12 * Math.sin(tLocal * 1.3)) * k,
          streaks: leakStreaksAt(tLocal, k),
        },
      };
    case "flash": {
      // One bright pop at the element start, decaying over ~0.4s.
      const gain = Math.exp(-9 * Math.max(0, tLocal));
      return { cssFilter: "", flash: Math.min(1, 0.85 * k * gain) };
    }
    case "shake": {
      const amp = SHAKE_AMP * k; // design px
      return {
        cssFilter: "",
        dx: amp * Math.sin(tLocal * 33),
        dy: amp * 0.7 * Math.cos(tLocal * 47),
        zoom: 1 + (amp * 2) / 1080,
      };
    }
    default:
      return { cssFilter: "" };
  }
}

/**
 * Apply one effect to the composited frame in place. `scratch` is a reusable
 * canvas the caller owns (same size as `canvas`); `grainTile` supplies the
 * shared noise tile (see looks.ts).
 */
export function applyEffectToCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  scratch: HTMLCanvasElement | OffscreenCanvas,
  effect: string,
  amount: number | undefined,
  tLocal: number,
  grainTileFor: (tick: number) => CanvasImageSource | null,
  focus?: { x: number; y: number },
  ramp?: number,
  dur?: number
): void {
  const state = effectPreviewState(effect, amount, tLocal, focus, ramp, dur);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  const sctx = scratch.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx || !sctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const scale = Math.min(W, H) / 1080;

  const needsRedraw = state.cssFilter || state.dx || state.dy || (state.zoom && state.zoom !== 1);
  if (needsRedraw) {
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(canvas, 0, 0);
    ctx.save();
    if (state.cssFilter) ctx.filter = state.cssFilter;
    const zoom = state.zoom ?? 1;
    const dx = (state.dx ?? 0) * scale;
    const dy = (state.dy ?? 0) * scale;
    // The scale holds its origin in place: the middle of the frame for a
    // shake, the chosen point for a zoom.
    const ox = state.origin?.x ?? 0.5;
    const oy = state.origin?.y ?? 0.5;
    ctx.drawImage(
      scratch,
      dx - W * (zoom - 1) * ox,
      dy - H * (zoom - 1) * oy,
      W * zoom,
      H * zoom
    );
    ctx.restore();
  }

  if (state.glow) {
    // A blurred copy of the frame laid back over itself — halation isolates
    // the highlights first, dreamy blooms the whole picture.
    const blurPx = Math.max(1, state.glow.blurFrac * H);
    sctx.clearRect(0, 0, W, H);
    sctx.filter = state.glow.bright
      ? `contrast(2.5) brightness(0.55) saturate(1.4) sepia(0.35) blur(${blurPx}px)`
      : `blur(${blurPx}px)`;
    sctx.drawImage(canvas, 0, 0);
    sctx.filter = "none";
    ctx.save();
    ctx.globalAlpha = state.glow.alpha;
    ctx.globalCompositeOperation = state.glow.mode;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  if (state.ghostFrac) {
    // Tinted ghost copies, the same approximation the VHS look previews with.
    const shift = state.ghostFrac * W;
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(canvas, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.globalCompositeOperation = "screen";
    ctx.drawImage(scratch, shift, 0);
    ctx.drawImage(scratch, -shift, 0);
    ctx.restore();
  }

  if (state.washes) {
    ctx.save();
    for (const w of state.washes) {
      ctx.globalCompositeOperation = w.mode;
      ctx.globalAlpha = w.alpha;
      ctx.fillStyle = w.color;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  if (state.leak) {
    const { x, y, alpha } = state.leak;
    const r = Math.max(W, H) * 0.7;
    const g = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, r);
    g.addColorStop(0, "rgba(255,190,120,0.9)");
    g.addColorStop(0.38, "rgba(255,150,60,0.5)");
    g.addColorStop(0.72, "rgba(255,120,40,0)");
    g.addColorStop(1, "rgba(255,120,40,0)");
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // The screen pass lights the darks and dies on a bright frame; a plain
    // pass at a fraction of the alpha tints the brights, so the bloom reads
    // on footage of any brightness.
    ctx.globalAlpha = alpha * LEAK_TINT;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillRect(0, 0, W, H);
    // The streak bands, each a linear gradient along its own tilt, blended
    // the same two ways as the bloom.
    for (const s of state.leak.streaks) {
      const th = (s.angle * Math.PI) / 180;
      const dx = Math.sin(th);
      const dy = -Math.cos(th);
      const L = W * Math.abs(dx) + H * Math.abs(dy);
      const sg = ctx.createLinearGradient(
        W / 2 - (dx * L) / 2,
        H / 2 - (dy * L) / 2,
        W / 2 + (dx * L) / 2,
        H / 2 + (dy * L) / 2
      );
      const cl = (f: number) => Math.min(1, Math.max(0, f));
      sg.addColorStop(cl(s.p - 2 * s.w), "rgba(255,200,140,0)");
      sg.addColorStop(cl(s.p), "rgba(255,200,140,0.9)");
      sg.addColorStop(cl(s.p + 2 * s.w), "rgba(255,200,140,0)");
      ctx.fillStyle = sg;
      ctx.globalAlpha = s.alpha;
      ctx.globalCompositeOperation = "screen";
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = s.alpha * LEAK_TINT;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }

  if (state.grain) {
    const tile = grainTileFor(Math.floor(tLocal * 30));
    if (tile) {
      ctx.save();
      ctx.globalAlpha = state.grain;
      ctx.globalCompositeOperation = "overlay";
      for (let y = 0; y < H; y += 256) {
        for (let x = 0; x < W; x += 256) ctx.drawImage(tile, x, y);
      }
      ctx.restore();
    }
  }

  if (state.vignette && state.vignette > 0) {
    const g = ctx.createRadialGradient(
      W / 2,
      H / 2,
      Math.min(W, H) * 0.35,
      W / 2,
      H / 2,
      Math.hypot(W, H) / 2
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, state.vignette)})`);
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  if (state.flash) {
    ctx.save();
    ctx.globalAlpha = state.flash;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

/* ---------------------------------------------------------------- ffmpeg */

/** The timeline gate every fragment carries (the gte*lt spelling keeps commas
 * out of quoted expressions). */
const gate = (a: number, b: number) => `enable='gte(t,${fmt(a)})*lt(t,${fmt(b)})'`;

/**
 * ffmpeg filter_complex lines rendering one effect from `[inLabel]` into
 * `[outLabel]`, active only inside [start, end). Every filter used is in the
 * LGPL build the shipped engine bundles. Null for an unknown id — the export
 * renders without the effect rather than failing.
 */
export function effectFilterLines(
  inLabel: string,
  outLabel: string,
  effect: string,
  amount: number | undefined,
  start: number,
  end: number,
  width: number,
  height: number,
  tag: string,
  focus?: { x: number; y: number },
  ramp?: number
): string[] | null {
  const custom = customEffects.get(effect);
  if (custom) return custom.filterLines(inLabel, outLabel, amount, start, end, width, height, tag);
  const k = clampAmount(amount);
  const en = gate(start, end);
  // Design px are px at a 1080 short side, the same convention the canvas
  // recipes use — scale by the short side so a vertical frame blurs by as
  // much as its preview did.
  const h = Math.min(width, height);
  const look = lookOf(effect);
  if (look) {
    // The graded copy renders on its own branch and replaces the frame only
    // inside the window, the same shape the shake recipe uses — a look chain
    // is several filters deep and not all of them take a timeline gate.
    const lines = lookFilterLines(`lkfi${tag}`, `lkfo${tag}`, look, k, height, "yuv420p", tag);
    if (!lines) return null;
    return [
      `[${inLabel}]split[lkfb${tag}][lkfi${tag}]`,
      ...lines,
      `[lkfb${tag}][lkfo${tag}]overlay=0:0:${en}:eof_action=pass[${outLabel}]`,
    ];
  }
  switch (effect as VisualEffectId) {
    case "zoom": {
      // The pushed-in copy renders on its own branch — scaled up, then laid
      // back over the frame so the focus point stays where it is — and
      // replaces the picture only inside the window. Scale and placement
      // mirror the canvas recipe, so the export lands on the same part of the
      // frame the preview showed.
      const z = zoomScale(k);
      const f = focusOf(focus);
      const r = zoomRampOf(ramp);
      if (r <= 0) {
        const zw = 2 * Math.ceil((width * z) / 2);
        const zh = 2 * Math.ceil((height * z) / 2);
        return [
          `[${inLabel}]split[efb${tag}][efs${tag}]`,
          `[efs${tag}]scale=${zw}:${zh},crop=${width}:${height}:` +
            `${Math.round((zw - width) * f.x)}:${Math.round((zh - height) * f.y)}[efc${tag}]`,
          `[efb${tag}][efc${tag}]overlay=0:0:${en}:eof_action=pass[${outLabel}]`,
        ];
      }
      // Ramped: the branch is rescaled every frame along the same eased curve
      // the canvas recipe walks, and the overlay reads the copy's live size,
      // so the focus holds while the picture grows into it.
      // In over the ramp, hold, back out over the same ramp before the end —
      // the same curve `zoomProgress` walks, so preview and export agree.
      const p =
        `min(min(max((t-${fmt(start)})/${fmt(r)},0),1),` +
        `min(max((${fmt(end)}-t)/${fmt(r)},0),1))`;
      const eased = `(${p})*(${p})*(3-2*(${p}))`;
      const grow = `(1+${fmt(z - 1)}*(${eased}))`;
      return [
        `[${inLabel}]split[efb${tag}][efs${tag}]`,
        `[efs${tag}]scale=w='trunc(iw*${grow}/2)*2':h='trunc(ih*${grow}/2)*2':eval=frame[efc${tag}]`,
        `[efb${tag}][efc${tag}]overlay=x='-(w-W)*${fmt(f.x)}':y='-(h-H)*${fmt(f.y)}':` +
          `${en}:eof_action=pass[${outLabel}]`,
      ];
    }
    case "grain":
      return [`[${inLabel}]noise=alls=${Math.round(12 + 40 * k)}:allf=t+u:${en}[${outLabel}]`];
    case "vhs":
      return [
        `[${inLabel}]rgbashift=rh=${Math.round(3 * k)}:bh=${-Math.round(3 * k)}:${en},` +
          `hue=s=${fmt(1 - 0.35 * k)}:${en},` +
          `gblur=sigma=${fmt((0.8 * k * h) / 1080)}:${en},` +
          `noise=alls=${Math.round(14 * k)}:allf=t+u:${en}[${outLabel}]`,
      ];
    case "glitch":
      return [
        `[${inLabel}]rgbashift=rh=${Math.round(8 * k)}:bh=${-Math.round(8 * k)}:rv=${Math.round(2 * k)}:${en},` +
          `noise=alls=${Math.round(8 * k)}:allf=t+u:${en}[${outLabel}]`,
      ];
    case "blur":
      return [`[${inLabel}]gblur=sigma=${fmt((10 * k * h) / 1080)}:${en}[${outLabel}]`];
    case "vignette":
      return [`[${inLabel}]vignette=angle=${fmt((k * Math.PI) / 3.5)}:${en}[${outLabel}]`];
    case "lightleak": {
      // The bloom: a warm tint, then a backward vignette whose center drifts
      // around the bottom-right, so the far corner — the top-left — glows and
      // wanders the way the preview's leak does. The streak bands land last,
      // drawn straight into the frame by geq with the preview's own tilt,
      // sweep and pulse: luma screened toward white, chroma pushed toward
      // orange. Every term is a ratio of the plane's W and H, so the
      // subsampled chroma planes stay in register with luma.
      const tl = `(T-${fmt(start)})`;
      const bandSum = STREAK_BANDS.slice(0, streakCount(k))
        .map((b) => {
          const th = (b.angle * Math.PI) / 180;
          const len = `(W*${fmt(Math.abs(Math.sin(th)))}+H*${fmt(Math.abs(Math.cos(th)))})`;
          const q = `((X-W/2)*${fmt(Math.sin(th))}+(Y-H/2)*${fmt(-Math.cos(th))})/${len}+0.5`;
          const p = `(${fmt(b.base)}+${fmt(b.drift)}*sin(${tl}*${fmt(b.sweep)}+${fmt(b.phase)}))`;
          const g = streakGain(k);
          const a = `(${fmt(0.55 * g)}+${fmt(0.3 * g)}*sin(${tl}*${fmt(b.pulse)}+${fmt(b.phase * 1.7)}))`;
          return `${a}*exp(-0.5*pow((${q}-${p})/${fmt(b.w)},2))`;
        })
        .join("+");
      const G = `min(${bandSum},1)`;
      return [
        `[${inLabel}]hue=s=${fmt(1 + 0.06 * k)}:${en},` +
          `colortemperature=temperature=${Math.round(6500 - 500 * k)}:${en},` +
          `vignette=angle=${fmt((k * Math.PI) / 5)}:mode=backward:` +
          `x0='w*(0.84-0.14*sin(t*0.9))':y0='h*(0.8-0.11*cos(t*0.6))':eval=frame:${en},` +
          `geq=lum='lum(X,Y)+(235-lum(X,Y))*${G}':cb='cb(X,Y)-40*${G}':cr='cr(X,Y)+26*${G}':${en}[${outLabel}]`,
      ];
    }
    case "flash":
      // A decaying brightness pop from the element start, added to luma per
      // frame by geq — `T` is the frame's time, so the decay rides every
      // frame of the window.
      return [
        `[${inLabel}]geq=lum='min(235,lum(X,Y)+${fmt(200 * k)}*exp(-9*(T-${fmt(start)})))':` +
          `cb='cb(X,Y)':cr='cr(X,Y)':${en}[${outLabel}]`,
      ];
    case "shake": {
      // The shaken copy renders on its own branch (overscaled, then cropped
      // with time-jittered offsets) and replaces the frame only inside the
      // window, so the rest of the video keeps its unscaled pixels. Zoom,
      // amplitude and phase mirror the canvas recipe above so the export
      // shakes exactly like the preview: design px scale with the short side,
      // and the jitter clock starts at the element, not at the timeline.
      const zoom = 1 + (2 * SHAKE_AMP * k) / 1080;
      const zw = 2 * Math.ceil((width * zoom) / 2);
      const zh = 2 * Math.ceil((height * zoom) / 2);
      const px = (SHAKE_AMP * k * Math.min(width, height)) / 1080;
      const ax = fmt(Math.min((zw - width) / 2, px));
      const ay = fmt(Math.min((zh - height) / 2, px * 0.7));
      const tl = `(t-${fmt(start)})`;
      return [
        `[${inLabel}]split[efb${tag}][efs${tag}]`,
        `[efs${tag}]scale=${zw}:${zh},crop=${width}:${height}:` +
          `x='(in_w-out_w)/2+${ax}*sin(${tl}*33)':y='(in_h-out_h)/2+${ay}*cos(${tl}*47)'[efc${tag}]`,
        `[efb${tag}][efc${tag}]overlay=0:0:${en}:eof_action=pass[${outLabel}]`,
      ];
    }
    default:
      return null;
  }
}
