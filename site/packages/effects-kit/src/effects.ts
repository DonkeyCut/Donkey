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
import { kitCanvas } from "./surface";

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
  | "negative"
  | "huecycle"
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
  /** A light leak's course; absent = drift. */
  leak?: LeakCourse;
  /** A glitch pinned to one kind, hitting with it on every step; absent =
   * the random schedule. */
  glitch?: GlitchKind;
  /** A flash's color; absent = white. */
  tone?: FlashTone;
  /** A flash's strobe rate in pulses a second; absent = one pop at the
   * element's start. */
  rate?: number;
  /** How a strobe's pulses land; absent = strobe. */
  rhythm?: FlashRhythm;
}

/** A flash's color: `white` pops the picture bright, `black` dips it dark. */
export const FLASH_TONES = ["white", "black"] as const;
export type FlashTone = (typeof FLASH_TONES)[number];

/** The strobe rates a flash takes, pulses a second. Each pulse holds the tone
 * for the first half of its period and shows the picture for the second: at 6
 * a 30 fps cut strobes 2–3 frames dark, 2–3 frames lit. */
export const FLASH_RATE_MIN = 0.5;
export const FLASH_RATE_MAX = 15;

/** How a strobe's pulses land: `strobe` fires every pulse at full strength;
 * `flicker` deals each pulse its own strength and leaves the weak ones dark,
 * the uneven exposure pop of a failing light. */
export const FLASH_RHYTHMS = ["strobe", "flicker"] as const;
export type FlashRhythm = (typeof FLASH_RHYTHMS)[number];

/** What a flash plays beyond its amount: its tone, strobe rate and rhythm. */
export type FlashPulse = Pick<EffectOverlay, "tone" | "rate" | "rhythm">;

/** How far past a frame's time a pulse is read, in pulses: at the top rate
 * every 30 fps frame lands on a pulse's edge, and the nudge keeps rounding
 * in the frame time from tipping it into the wrong half. */
const PULSE_NUDGE = 1e-3;

/** A flicker's pulses dealt under this strength stay dark. */
const FLICKER_SKIP = 0.4;

/** The strength a flicker deals pulse `n`, 0..1: a sine hash ffmpeg's
 * expressions compute the same way (see the flash's geq). */
const flickerDeal = (n: number) => {
  const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/** The strobe rate a flash plays at, clamped; 0 = a single pop. */
const flashRate = (p?: FlashPulse) =>
  p?.rate ? Math.max(FLASH_RATE_MIN, Math.min(FLASH_RATE_MAX, p.rate)) : 0;

/** The tone's strength while a strobe's pulse holds it (its first half), 0
 * while it shows the picture. A strobe pulse holds at 1; a flicker pulse at
 * its dealt strength, or 0 when the deal is weak. */
const flashOn = (tLocal: number, rate: number, rhythm?: FlashRhythm) => {
  const p = Math.max(0, tLocal) * rate + PULSE_NUDGE;
  if (p % 1 >= 0.5) {
    return 0;
  }
  if (rhythm !== "flicker") {
    return 1;
  }
  const deal = flickerDeal(Math.floor(p));
  return deal < FLICKER_SKIP ? 0 : deal;
};

/** How a light leak plays: `drift` glows and wanders for as long as it is
 * up; `burn` is the film burn, played once across the element's length;
 * `scorch` flashes the picture through hot yellow, orange and red tones,
 * a new one each frame. */
export const LEAK_COURSES = ["drift", "burn", "scorch"] as const;
export type LeakCourse = (typeof LEAK_COURSES)[number];

/** The kinds a glitch breaks the picture with. The random schedule deals the
 * first four; `rgb` pulls the color channels apart (red one way, blue the
 * other) and plays only when a glitch is pinned to it. */
export const GLITCH_KINDS = ["smear", "split", "tint", "blowout", "rgb"] as const;
export type GlitchKind = (typeof GLITCH_KINDS)[number];

/** The recipes the renderers draw: every picture effect, the burn a light
 * leak plays on its burn course, and a glitch pinned to one kind. */
type RecipeId = VisualEffectId | "burn" | "scorch" | `glitch:${GlitchKind}`;

/** The recipe an effect element renders with. Every renderer resolves the
 * element through here, so a light leak on its burn course draws the burn
 * recipe, and a pinned glitch its kind, in the preview, the in-tab export and
 * the ffmpeg graph alike. */
export const effectRecipe = (e: { effect: string; leak?: LeakCourse; glitch?: GlitchKind }): string =>
  e.effect === "lightleak" && (e.leak === "burn" || e.leak === "scorch")
    ? e.leak
    : e.effect === "glitch" && e.glitch && (GLITCH_KINDS as readonly string[]).includes(e.glitch)
      ? `glitch:${e.glitch}`
      : e.effect;

/** The kind a pinned-glitch recipe holds to, e.g. "glitch:rgb" → "rgb". */
const pinnedGlitch = (recipe: string): GlitchKind | undefined => {
  const kind = recipe.startsWith("glitch:") ? recipe.slice("glitch:".length) : "";
  return (GLITCH_KINDS as readonly string[]).includes(kind) ? (kind as GlitchKind) : undefined;
};

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
  "negative",
  "huecycle",
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

/**
 * The effects a clip wears treat that clip's picture alone, inside its mask,
 * for the clip's whole length: a masked copy over the shot wears a negative
 * and only the window turns. Zoom and shake move the frame, which a clip
 * does with its own zoom and pose keys; the looks are the clip's grade.
 */
export const CLIP_EFFECT_IDS = [
  "negative",
  "huecycle",
  "grain",
  "vhs",
  "glitch",
  "blur",
  "vignette",
  "lightleak",
  "flash",
] as const satisfies readonly VisualEffectId[];

/** The picture treatments a clip can wear itself. */
export type ClipEffectId = (typeof CLIP_EFFECT_IDS)[number];

/** How an effect meets the canvas edge: `opaque` paints the whole canvas (a
 * frame), `keep` paints only where the picture is (a clip's own picture,
 * which may be a still with clear corners). */
export type EffectEdges = "opaque" | "keep";

/** One effect a clip wears; `amount` 0..1, absent = 0.5. */
export interface ClipEffect extends FlashPulse {
  effect: ClipEffectId;
  amount?: number;
}

/** The effects with nothing to dial: a negative flips every color whatever
 * the amount says. */
export const AMOUNTLESS_EFFECTS: EffectId[] = ["negative"];

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
  negative: "Negative",
  huecycle: "Color cycle",
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

/**
 * The film burn, a light leak's burn course: the frame catches from its
 * bottom edge, the burn climbs to the top behind a hot orange front, flares
 * near white, settles to orange and lets the picture back in its last
 * moments — the burn-out at the end of a teaser. It plays across the
 * element's own length, so a short element burns fast and a long one slowly.
 */

/** Length the burn plays over when nothing gives it one. */
export const BURN_SECONDS = 1.2;

/** One stop of the burn's vertical profile: `at` is height from the bottom
 * edge as a frame fraction, `rgb` the color, `a` its opacity. */
export interface BurnStop {
  at: number;
  rgb: [number, number, number];
  a: number;
}

/** A diagonal band of darker flame sweeping through the flare. Same axis
 * convention as a leak streak: `angle` in CSS gradient degrees, `p` the band
 * center along that axis, `w` its half-width. */
export interface BurnStreak {
  angle: number;
  p: number;
  w: number;
  alpha: number;
}

/** The burn at one moment: its vertical profile, laid over the picture at
 * `alpha`, and the flame band over that. */
export interface BurnPaint {
  stops: BurnStop[];
  alpha: number;
  streak?: BurnStreak;
}

/** The burn's colors: the near-white flare, the yellow it cools through, the
 * orange it settles at, the front's hot edge and the flame band. */
const BURN_FLARE: [number, number, number] = [255, 244, 194];
const BURN_YELLOW: [number, number, number] = [255, 216, 102];
const BURN_ORANGE: [number, number, number] = [247, 168, 58];
const BURN_EDGE: [number, number, number] = [255, 106, 26];
export const BURN_FLAME: [number, number, number] = [232, 120, 42];

/** How far the burned body runs under the front, how wide the hot edge is,
 * and how far its glow reaches above it — frame fractions. */
const BURN_BODY = 0.08;
const BURN_EDGE_W = 0.02;
const BURN_GLOW = 0.1;
/** Share of the burn spent climbing, and where the picture starts to return. */
const BURN_RISE = 0.32;
const BURN_RELEASE = 0.9;
/** The flame band: it crosses while `u` runs from `from` over `span`, its
 * center sliding from `p0` by `travel` along a band tilted `angle` degrees,
 * `w` wide at peak opacity `alpha`. */
const BURN_STREAK = { from: 0.25, span: 0.35, angle: 30, p0: 1.1, travel: 1.2, w: 0.08, alpha: 0.7 };

const smooth = (p: number) => {
  const q = Math.max(0, Math.min(1, p));
  return q * q * (3 - 2 * q);
};
const mixRgb = (a: [number, number, number], b: [number, number, number], p: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * p,
  a[1] + (b[1] - a[1]) * p,
  a[2] + (b[2] - a[2]) * p,
];

/** The burn's body color `u` of the way through: flare, then yellow, then
 * orange. */
function burnCore(u: number): [number, number, number] {
  if (u < 0.4) return BURN_FLARE;
  if (u < 0.6) return mixRgb(BURN_FLARE, BURN_YELLOW, smooth((u - 0.4) / 0.2));
  return mixRgb(BURN_YELLOW, BURN_ORANGE, smooth((u - 0.6) / 0.25));
}

/**
 * The profile clipped to the frame, so every renderer reads stops inside
 * [0, 1] and draws the same piecewise-linear ramp. A stop past an edge is
 * replaced by the ramp's value at that edge.
 */
function clipStops(stops: BurnStop[]): BurnStop[] {
  const at = (x: number): BurnStop => {
    if (x <= stops[0].at) return { ...stops[0], at: x };
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1];
      const b = stops[i];
      if (x > b.at) continue;
      const p = b.at > a.at ? (x - a.at) / (b.at - a.at) : 1;
      return { at: x, rgb: mixRgb(a.rgb, b.rgb, p), a: a.a + (b.a - a.a) * p };
    }
    return { ...stops[stops.length - 1], at: x };
  };
  const inside = stops.filter((s) => s.at > 0 && s.at < 1);
  return [at(0), ...inside, at(1)];
}

/** The burn `tLocal` seconds into an element `dur` long, at amount `k`. */
export function burnAt(tLocal: number, dur: number, k: number): BurnPaint {
  const u = Math.max(0, Math.min(1, tLocal / Math.max(dur, 1e-3)));

  // The front climbs from the bottom edge until its glow has left the top.
  const h = (1 + BURN_GLOW + BURN_EDGE_W) * smooth(u / BURN_RISE);
  const core = burnCore(u);
  const stops = clipStops([
    { at: h - BURN_BODY, rgb: core, a: 1 },
    { at: h - BURN_EDGE_W, rgb: BURN_EDGE, a: 1 },
    { at: h + BURN_GLOW, rgb: BURN_EDGE, a: 0 },
  ]);

  // Opaque at full amount; the release hands the picture back.
  const peak = 0.7 + 0.3 * k;
  const alpha = peak * (1 - smooth((u - BURN_RELEASE) / (1 - BURN_RELEASE)));

  // The flame band crosses the frame while the burn flares.
  const B = BURN_STREAK;
  const f = (u - B.from) / B.span;
  const streak = f > 0 && f < 1 ? { angle: B.angle, p: B.p0 - B.travel * f, w: B.w, alpha: B.alpha * Math.sin(Math.PI * f) } : undefined;
  return streak ? { stops, alpha, streak } : { stops, alpha };
}

const rgba = (c: [number, number, number], a: number) =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${fmt(a)})`;

/** The CSS background of the burn's body — the DOM twin of the canvas pass's
 * vertical gradient; lay it over the picture at the burn's alpha. */
export const burnGradient = (b: BurnPaint) =>
  `linear-gradient(to top, ${b.stops.map((s) => `${rgba(s.rgb, s.a)} ${(s.at * 100).toFixed(2)}%`).join(", ")})`;

/** The CSS background of the flame band, at the band's own alpha. */
export const burnStreakGradient = (s: BurnStreak) =>
  `linear-gradient(${s.angle}deg, ${rgba(BURN_FLAME, 0)} ${((s.p - 2 * s.w) * 100).toFixed(1)}%, ` +
  `${rgba(BURN_FLAME, 1)} ${(s.p * 100).toFixed(1)}%, ` +
  `${rgba(BURN_FLAME, 0)} ${((s.p + 2 * s.w) * 100).toFixed(1)}%)`;

/** The ellipse a wash covers, in frame fractions: center (x, y), radii (rx,
 * ry). The wash holds its full strength out to `inner` of the way to the rim
 * and fades to nothing at it. */
export interface WashArea {
  x: number;
  y: number;
  rx: number;
  ry: number;
  inner: number;
}

/** A hex wash color with no alpha: a patch's ramp fades to it, so canvas
 * gradients, which blend unpremultiplied, never pass through black, e.g.
 * "#f4d628" → "rgba(244,214,40,0)". */
function clearOf(color: string): string {
  const n = parseInt(color.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0)`;
}

/** The CSS background of a wash: its color over the frame, or a radial ramp
 * over its patch — the DOM twin of the canvas pass's gradient. */
export function washBackground(color: string, area?: WashArea): string {
  if (!area) {
    return color;
  }
  const pct = (v: number) => `${fmt(v * 100)}%`;
  return `radial-gradient(ellipse ${pct(area.rx)} ${pct(area.ry)} at ${pct(area.x)} ${pct(area.y)}, ${color} ${pct(area.inner)}, ${clearOf(color)} 100%)`;
}

/** What one effect asks the preview canvas to do at `tLocal` seconds in. */
export interface EffectPreviewState {
  /** ctx.filter for a self-redraw of the frame; "" = none. */
  cssFilter: string;
  /** Animated noise-tile alpha 0..1. */
  grain?: number;
  /** Radial corner darkening 0..1. */
  vignette?: number;
  /** Flat washes over the picture, each over the whole frame or one patch. */
  washes?: { color: string; alpha: number; mode: GlobalCompositeOperation; area?: WashArea }[];
  /** A light leak's bloom: a warm radial glow centered at (x, y) in frame
   * fractions, screen-blended over the picture at `alpha`, with the streak
   * bands sweeping over it. */
  leak?: { x: number; y: number; alpha: number; streaks: LeakStreak[] };
  /** Chroma ghosting: tinted copies offset by this frame-width fraction. */
  ghostFrac?: number;
  /** A channel split: red drawn moved by (dx, dy) design px, blue by the
   * opposite, green in place. */
  rgb?: { dx: number; dy: number };
  /** Whole-frame flash alpha 0..1. */
  flash?: number;
  /** The flash's color; absent = white. */
  flashTone?: FlashTone;
  /** Frame offset in design px (1080 short side). */
  dx?: number;
  dy?: number;
  /** Frame scale: a shake's slight overscale to keep its edges covered, a
   * zoom's push in. */
  zoom?: number;
  /** The point `zoom` scales about, in frame fractions; absent = the middle. */
  origin?: { x: number; y: number };
  /** A pixel stretch: the frame scaled `scale` times taller about the row at
   * `row` (a frame fraction), so one thin band smears into vertical streaks. */
  stretch?: { row: number; scale: number };
  /** The frame before it moved, laid back over the moved one at this alpha
   * with a lighten blend: a doubled picture. */
  ghost?: number;
  /** Self-copy glow: blur radius as a fraction of frame height, blended back
   * over the picture; `bright` isolates highlights first (halation). */
  glow?: { blurFrac: number; alpha: number; mode: "screen" | "lighten"; bright?: boolean };
  /** A film burn climbing over the picture (see `burnAt`). */
  burn?: BurnPaint;
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

/** How fast a color cycle turns the hue wheel, in turns per second, at the
 * lowest and highest amount. */
const HUE_TURNS_MIN = 0.1;
const HUE_TURNS_MAX = 1.5;
const hueTurns = (k: number) => HUE_TURNS_MIN + (HUE_TURNS_MAX - HUE_TURNS_MIN) * k;

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

/**
 * The glitch: clean footage broken by runs of corrupted frames. Time runs in
 * steps of `1 / GLITCH_RATE` seconds; a step can start a run of one kind, and
 * the latest run that started still plays until it ends:
 *
 * - smear: the frame stretched tall about one row into dark streaks, blurred,
 *   a new row each step (1–3 steps).
 * - split: the frame knocked sideways with the unmoved frame lightened back
 *   over it, so the picture doubles, an orange burn glowing up from the
 *   bottom and dust over it all (2–5 steps).
 * - tint: a blurred teal close-up of one corner (1–2 steps).
 * - blowout: one overexposed frame.
 *
 * The schedule is an integer hash of the step, so the preview, the in-tab
 * export and ffmpeg land the same hits on the same frames in every JS engine.
 */
const GLITCH_RATE = 15;
/** How many times taller a smear draws the frame about its row: 1/60th of
 * the picture runs over all of it. */
const GLITCH_STRETCH = 60;
/** How far a tint pushes into its corner. */
const GLITCH_TINT_ZOOM = 1.6;
/** The doubled frame's share in a split. */
const GLITCH_GHOST = 0.55;

/** Each kind's share of the runs and how many steps a run of it lasts. */
const GLITCH_RUNS: { kind: GlitchKind; weight: number; min: number; max: number }[] = [
  { kind: "smear", weight: 0.45, min: 1, max: 3 },
  { kind: "split", weight: 0.25, min: 2, max: 5 },
  { kind: "tint", weight: 0.15, min: 1, max: 2 },
  { kind: "blowout", weight: 0.15, min: 1, max: 1 },
];
const GLITCH_RUN_MAX = Math.max(...GLITCH_RUNS.map((r) => r.max));

export interface GlitchHit {
  kind: GlitchKind;
  /** The row a smear runs from, a frame fraction; new every step. */
  row: number;
  /** How far a split knocks the frame sideways, a signed short-side fraction;
   * held for the run. */
  shift: number;
  /** The corner a tint pushes into, frame fractions; held for the run. */
  focus: { x: number; y: number };
}

/** Slack on a step's edges, in seconds, well under a frame: a frame time
 * that lands on an edge belongs to the step it opens in every renderer, ffmpeg's
 * rounded clock included. */
const STEP_SLACK = 1e-4;

/** The step `tLocal` seconds into the effect falls in. */
const glitchStep = (tLocal: number) => Math.floor((tLocal + STEP_SLACK) * GLITCH_RATE);

/** A step's hash on one channel, 0..1. */
function stepHash(step: number, salt: number): number {
  let h = Math.imul(step ^ Math.imul(salt, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The share of steps that start a run: about a third of the frames glitch
 * at the default amount, half at the top. */
const glitchOdds = (k: number) => 0.05 + 0.2 * k;

/** The run step `step` starts, if it starts one. */
function glitchRunAt(step: number, k: number): { kind: GlitchKind; len: number } | null {
  if (step < 0 || stepHash(step, 1) >= glitchOdds(k)) return null;
  let pick = stepHash(step, 2);
  const run = GLITCH_RUNS.find((r) => (pick -= r.weight) < 0) ?? GLITCH_RUNS[GLITCH_RUNS.length - 1];
  return { kind: run.kind, len: run.min + Math.floor(stepHash(step, 6) * (run.max - run.min + 1)) };
}

/** What the glitch does on step `step` at amount `k`; null = a clean step.
 * The latest run to start plays until it ends, then the picture is clean
 * until the next one. A pinned glitch hits with its kind on every step, the
 * row, shift and corner dealt fresh each step. */
export function glitchHitAt(step: number, k: number, pin?: GlitchKind): GlitchHit | null {
  if (pin) {
    return {
      kind: pin,
      row: 0.15 + 0.7 * stepHash(step, 3),
      shift: (stepHash(step, 4) < 0.5 ? -1 : 1) * (0.06 + 0.1 * stepHash(step, 5)),
      focus: { x: 0.15 + 0.7 * stepHash(step, 7), y: 0.15 + 0.7 * stepHash(step, 8) },
    };
  }
  for (let from = step; from > step - GLITCH_RUN_MAX; from--) {
    const run = glitchRunAt(from, k);
    if (!run) continue;
    if (from + run.len <= step) return null;
    const side = stepHash(from, 4) < 0.5 ? -1 : 1;
    return {
      kind: run.kind,
      row: 0.15 + 0.7 * stepHash(step, 3),
      shift: side * (0.06 + 0.1 * stepHash(from, 5)),
      focus: { x: 0.15 + 0.7 * stepHash(from, 7), y: 0.15 + 0.7 * stepHash(from, 8) },
    };
  }
  return null;
}

/** How far an rgb hit pulls the channels apart, as shares of its shift: red
 * moves by (x, y) of it and blue by the opposite, mostly up and down. A
 * shift of 0.1 moves red 8 px across and 27 px down at 1080. */
const GLITCH_RGB = { x: 0.075, y: 0.25 };

/** An rgb hit's channel offset in design px (1080 short side). */
const glitchRgb = (h: GlitchHit) => ({ dx: h.shift * GLITCH_RGB.x * 1080, dy: h.shift * GLITCH_RGB.y * 1080 });

/** The split's burn: a warm bloom low on the frame, the light-leak paint. */
const GLITCH_BURN = { x: 0.25, y: 1.15, alpha: 0.75 };

/** The canvas/DOM state of one glitch hit. */
function glitchState(hit: GlitchHit | null): EffectPreviewState {
  if (!hit) return { cssFilter: "" };
  switch (hit.kind) {
    case "smear":
      return {
        cssFilter: "brightness(0.6) contrast(1.25) blur(1.5px)",
        stretch: { row: hit.row, scale: GLITCH_STRETCH },
        grain: 0.3,
      };
    case "split":
      return {
        cssFilter: "contrast(1.1) saturate(1.25)",
        dx: hit.shift * 1080,
        ghost: GLITCH_GHOST,
        leak: { ...GLITCH_BURN, streaks: [] },
        grain: 0.35,
      };
    case "tint":
      return {
        cssFilter: "sepia(1) hue-rotate(125deg) saturate(1.6) brightness(0.7) blur(3px)",
        zoom: GLITCH_TINT_ZOOM,
        origin: hit.focus,
      };
    case "blowout":
      return { cssFilter: "brightness(2.2) contrast(1.5) saturate(0.35)" };
    case "rgb":
      return { cssFilter: "", rgb: glitchRgb(hit) };
  }
}

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
  dur?: number,
  pulse?: FlashPulse
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
  // A pinned glitch plays its kind on every step.
  const pin = pinnedGlitch(effect);
  if (pin) {
    return glitchState(glitchHitAt(glitchStep(tLocal), k, pin));
  }
  switch (effect as RecipeId) {
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
    case "glitch":
      return glitchState(glitchHitAt(glitchStep(tLocal), k));
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
      // One pop at the element start, decaying over ~0.4s; on a strobe, the
      // tone held hard for the first half of every pulse.
      const tone = pulse?.tone === "black" ? "black" : undefined;
      const rate = flashRate(pulse);
      const gain = rate ? flashOn(tLocal, rate, pulse?.rhythm) : Math.exp(-9 * Math.max(0, tLocal));
      return { cssFilter: "", flash: Math.min(1, 0.85 * k * gain), ...(tone ? { flashTone: tone } : {}) };
    }
    case "burn":
      return { cssFilter: "", burn: burnAt(tLocal, dur ?? BURN_SECONDS, k) };
    case "scorch":
      return scorchState(tLocal, k);
    case "shake": {
      const amp = SHAKE_AMP * k; // design px
      return {
        cssFilter: "",
        dx: amp * Math.sin(tLocal * 33),
        dy: amp * 0.7 * Math.cos(tLocal * 47),
        zoom: 1 + (amp * 2) / 1080,
      };
    }
    case "negative":
      // Every color flipped to its opposite: black to white, skin to cyan.
      return { cssFilter: "invert(1)" };
    case "huecycle": {
      // The hue wheel turns at the amount's pace from the element's start.
      const deg = (360 * hueTurns(k) * Math.max(0, tLocal)) % 360;
      return { cssFilter: `hue-rotate(${fmt(deg)}deg)` };
    }
    default:
      return { cssFilter: "" };
  }
}

/** The plane an rgb split builds its tinted copies on, one per scratch: it
 * lives as long as the caller's scratch and follows the frame's size, so a
 * run of split frames draws on one plane. */
const splitPlanes = new WeakMap<HTMLCanvasElement | OffscreenCanvas, HTMLCanvasElement>();
function splitPlane(scratch: HTMLCanvasElement | OffscreenCanvas, w: number, h: number): HTMLCanvasElement {
  const plane = splitPlanes.get(scratch);
  if (!plane) {
    const made = kitCanvas(w, h);
    splitPlanes.set(scratch, made);
    return made;
  }
  if (plane.width !== w || plane.height !== h) {
    plane.width = w;
    plane.height = h;
  }
  return plane;
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
  dur?: number,
  edges: EffectEdges = "opaque",
  pulse?: FlashPulse
): void {
  const state = effectPreviewState(effect, amount, tLocal, focus, ramp, dur, pulse);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  const sctx = scratch.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx || !sctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const scale = Math.min(W, H) / 1080;

  // Paint laid over the picture. A clear picture edge takes it only where
  // the picture is: a plain paint lands atop, and a blended one is first cut
  // to the picture's coverage on the scratch.
  const over = (mode: GlobalCompositeOperation, alpha: number, paint: (c: CanvasRenderingContext2D) => void) => {
    const direct = edges === "opaque" || mode === "source-over";
    const target = direct ? ctx : sctx;
    target.save();
    target.globalAlpha = direct ? alpha : 1;
    target.globalCompositeOperation = edges === "keep" && mode === "source-over" ? "source-atop" : direct ? mode : "source-over";
    if (!direct) target.clearRect(0, 0, W, H);
    paint(target);
    target.restore();
    if (direct) return;
    sctx.save();
    sctx.globalCompositeOperation = "destination-in";
    sctx.drawImage(canvas, 0, 0);
    sctx.restore();
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = mode;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  };

  const needsRedraw = state.cssFilter || state.dx || state.dy || state.stretch || (state.zoom && state.zoom !== 1);
  if (needsRedraw) {
    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(canvas, 0, 0);
    // Over a clear edge the old picture would show through the redraw. A
    // moved frame uncovers an edge, which shows black as it does under the
    // preview's stage; a shake's overscale covers its own.
    if (edges === "keep") ctx.clearRect(0, 0, W, H);
    else if (state.dx || state.dy) {
      ctx.save();
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    ctx.save();
    if (state.cssFilter) ctx.filter = state.cssFilter;
    const zoom = state.zoom ?? 1;
    const dx = (state.dx ?? 0) * scale;
    const dy = (state.dy ?? 0) * scale;
    // The scale holds its origin in place: the middle of the frame for a
    // shake, the chosen point for a zoom.
    const ox = state.origin?.x ?? 0.5;
    const oy = state.origin?.y ?? 0.5;
    // A stretch draws only the thin band about its row, scaled to the full
    // height: the band that holds the row in place, e.g. row 0.5 at scale 60
    // is the 1/60th of the frame around its middle.
    const sy = state.stretch?.scale ?? 1;
    const band = H / sy;
    const bandTop = (state.stretch?.row ?? 0) * (H - band);
    ctx.drawImage(
      scratch,
      0,
      bandTop,
      W,
      band,
      dx - W * (zoom - 1) * ox,
      dy - H * (zoom - 1) * oy,
      W * zoom,
      H * zoom
    );
    ctx.restore();
    // The unmoved frame lightened back over the moved one doubles the
    // picture, and fills the edge the move uncovered.
    if (state.ghost) {
      ctx.save();
      ctx.globalAlpha = state.ghost;
      ctx.globalCompositeOperation = "lighten";
      ctx.drawImage(scratch, 0, 0);
      ctx.restore();
    }
  }

  if (state.rgb) {
    // A channel split: the frame is copied off and rebuilt as three tinted
    // copies added back up — red moved by the offset, green in place, blue
    // moved the other way. Each copy keeps its own coverage, so a clear edge
    // stays clear. The copies build on the scratch's split plane.
    const ox = state.rgb.dx * scale;
    const oy = state.rgb.dy * scale;
    const plane = splitPlane(scratch, W, H);
    const pctx = plane.getContext("2d") as CanvasRenderingContext2D | null;
    if (pctx) {
      sctx.clearRect(0, 0, W, H);
      sctx.drawImage(canvas, 0, 0);
      ctx.save();
      ctx.clearRect(0, 0, W, H);
      if (edges === "opaque") {
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, W, H);
      }
      ctx.globalCompositeOperation = "lighter";
      const copies: [string, number, number][] = [
        ["#ff0000", ox, oy],
        ["#00ff00", 0, 0],
        ["#0000ff", -ox, -oy],
      ];
      for (const [tint, mx, my] of copies) {
        pctx.globalCompositeOperation = "source-over";
        pctx.clearRect(0, 0, W, H);
        pctx.drawImage(scratch, mx, my);
        pctx.globalCompositeOperation = "multiply";
        pctx.fillStyle = tint;
        pctx.fillRect(0, 0, W, H);
        pctx.globalCompositeOperation = "destination-in";
        pctx.drawImage(scratch, mx, my);
        ctx.drawImage(plane, 0, 0);
      }
      ctx.restore();
    }
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

  for (const w of state.washes ?? []) {
    over(w.mode, w.alpha, (c) => {
      const a = w.area;
      if (!a) {
        c.fillStyle = w.color;
        c.fillRect(0, 0, W, H);
        return;
      }

      // A patch: a unit circle's ramp stretched onto the ellipse, filled
      // over the frame in the stretched space.
      const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(a.inner, w.color);
      g.addColorStop(1, clearOf(w.color));
      c.translate(a.x * W, a.y * H);
      c.scale(a.rx * W, a.ry * H);
      c.fillStyle = g;
      c.fillRect(-a.x / a.rx, -a.y / a.ry, 1 / a.rx, 1 / a.ry);
    });
  }

  if (state.leak) {
    const { x, y, alpha } = state.leak;
    const r = Math.max(W, H) * 0.7;
    const g = ctx.createRadialGradient(x * W, y * H, 0, x * W, y * H, r);
    g.addColorStop(0, "rgba(255,190,120,0.9)");
    g.addColorStop(0.38, "rgba(255,150,60,0.5)");
    g.addColorStop(0.72, "rgba(255,120,40,0)");
    g.addColorStop(1, "rgba(255,120,40,0)");
    const fill = (style: CanvasGradient) => (c: CanvasRenderingContext2D) => {
      c.fillStyle = style;
      c.fillRect(0, 0, W, H);
    };
    // The screen pass lights the darks and dies on a bright frame; a plain
    // pass at a fraction of the alpha tints the brights, so the bloom reads
    // on footage of any brightness.
    over("screen", alpha, fill(g));
    over("source-over", alpha * LEAK_TINT, fill(g));
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
      over("screen", s.alpha, fill(sg));
      over("source-over", s.alpha * LEAK_TINT, fill(sg));
    }
  }

  if (state.grain) {
    const tile = grainTileFor(Math.floor(tLocal * 30));
    if (tile) {
      over("overlay", state.grain, (c) => {
        for (let y = 0; y < H; y += 256) {
          for (let x = 0; x < W; x += 256) c.drawImage(tile, x, y);
        }
      });
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
    over("source-over", 1, (c) => {
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    });
  }

  if (state.flash) {
    over("source-over", state.flash, (c) => {
      c.fillStyle = state.flashTone === "black" ? "#000000" : "#FFFFFF";
      c.fillRect(0, 0, W, H);
    });
  }

  if (state.burn) {
    // The burned body, bottom edge up, then the flame band over it.
    const b = state.burn;
    const body = ctx.createLinearGradient(0, H, 0, 0);
    for (const s of b.stops) body.addColorStop(s.at, rgba(s.rgb, s.a));
    over("source-over", b.alpha, (c) => {
      c.fillStyle = body;
      c.fillRect(0, 0, W, H);
    });
    if (b.streak) {
      // The band's stops may fall past the frame; the gradient line is
      // stretched to cover them, so the ramp is the one the CSS twin draws.
      const s = b.streak;
      const th = (s.angle * Math.PI) / 180;
      const ux = Math.sin(th);
      const uy = -Math.cos(th);
      const L = W * Math.abs(ux) + H * Math.abs(uy);
      const lo = Math.min(0, s.p - 2 * s.w);
      const hi = Math.max(1, s.p + 2 * s.w);
      const pt = (f: number) => [W / 2 + ux * L * (f - 0.5), H / 2 + uy * L * (f - 0.5)] as const;
      const [x0, y0] = pt(lo);
      const [x1, y1] = pt(hi);
      const band = ctx.createLinearGradient(x0, y0, x1, y1);
      const at = (f: number) => (f - lo) / (hi - lo);
      band.addColorStop(at(s.p - 2 * s.w), rgba(BURN_FLAME, 0));
      band.addColorStop(at(s.p), rgba(BURN_FLAME, 1));
      band.addColorStop(at(s.p + 2 * s.w), rgba(BURN_FLAME, 0));
      over("source-over", s.alpha * b.alpha, (c) => {
        c.fillStyle = band;
        c.fillRect(0, 0, W, H);
      });
    }
  }
}

/**
 * A clip's effects over its picture, in order, at `tLocal` on the effects'
 * clock. A run of effects that are a canvas filter and nothing else — a
 * negative, a color cycle, a blur — draws once with the filters joined, and
 * paint lands only where the picture is, so a still's clear corners stay
 * clear.
 */
export function applyClipEffects(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  scratch: HTMLCanvasElement | OffscreenCanvas,
  effects: readonly ClipEffect[],
  tLocal: number,
  grainTileFor: (tick: number) => CanvasImageSource | null
): void {
  let filters: string[] = [];
  const flush = () => {
    if (filters.length > 0) redrawFiltered(canvas, scratch, filters.join(" "));
    filters = [];
  };
  for (const e of effects) {
    const { cssFilter, ...passes } = effectPreviewState(e.effect, e.amount, tLocal, undefined, undefined, undefined, e);
    if (Object.values(passes).every((v) => v === undefined)) {
      if (cssFilter) filters.push(cssFilter);
      continue;
    }
    flush();
    applyEffectToCanvas(canvas, scratch, e.effect, e.amount, tLocal, grainTileFor, undefined, undefined, undefined, "keep", e);
  }
  flush();
}

/** The canvas redrawn through `filter`, alpha and all. */
function redrawFiltered(canvas: HTMLCanvasElement | OffscreenCanvas, scratch: HTMLCanvasElement | OffscreenCanvas, filter: string) {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  const sctx = scratch.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx || !sctx) return;
  sctx.clearRect(0, 0, canvas.width, canvas.height);
  sctx.drawImage(canvas, 0, 0);
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.filter = filter;
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}

/* ---------------------------------------------------------------- ffmpeg */

/** A window edge in seconds, to the microsecond: a time floored to the
 * tenth of a millisecond still opens on the frame it sits just under. */
const edge = (t: number) => t.toFixed(6);

/** The timeline gate every fragment carries (the gte*lt spelling keeps commas
 * out of quoted expressions). */
const gate = (a: number, b: number) => `enable='gte(t,${edge(a)})*lt(t,${edge(b)})'`;

/** The pixel family a chain works in: the format its branches carry, the
 * option that keeps `overlay` blending in the same one, and the bits a plane
 * holds — the recipes below are written in 8-bit code values and scale to
 * the plane's depth. A 4:2:0 8-bit graph is the default, which is what
 * `overlay` picks on its own. */
export interface ChainChroma {
  pixFmt: string;
  overlay: string;
  /** Bits a plane; absent = 8. An HDR composite carries 10. */
  depth?: 8 | 10;
}

export const CHROMA_420: ChainChroma = { pixFmt: "yuv420p", overlay: "" };

/** The factor an 8-bit code value scales by to land on a plane of `depth`
 * bits: 1 at 8, (1023 / 255) at 10. */
export const codeScale = (depth: 8 | 10 | undefined): number => ((1 << (depth ?? 8)) - 1) / 255;

/** An 8-bit code value spelled at the chain's depth. */
const code = (v: number, depth: 8 | 10 | undefined): string => fmt(v * codeScale(depth));

/**
 * The glitch in ffmpeg: the run schedule is walked here and spelled as
 * per-frame expressions, one branch per kind, each gated to its own steps.
 *
 * - smear: a band cropped at the step's row (crop's y runs per frame), scaled
 *   to full height, darkened and softened, laid over the frame.
 * - tint: the run's corner cropped and scaled up, cast teal, blurred.
 * - split: the frame blacked, a copy laid back at the run's offset, the
 *   unmoved frame lightened over it, then the burn glowing up from the bottom.
 * - blowout: a lift and desaturate of the whole frame.
 *
 * Smear and split carry dust, the preview's grain.
 */
function glitchFilterLines(
  inLabel: string,
  outLabel: string,
  k: number,
  start: number,
  end: number,
  width: number,
  height: number,
  tag: string,
  chroma: ChainChroma,
  pin?: GlitchKind
): string[] {
  const hits: { a: number; b: number; hit: GlitchHit }[] = [];
  const steps = Math.ceil((end - start) * GLITCH_RATE);
  for (let step = 0; step < steps; step++) {
    const hit = glitchHitAt(step, k, pin);
    if (!hit) continue;
    hits.push({ a: start + step / GLITCH_RATE, b: Math.min(end, start + (step + 1) / GLITCH_RATE), hit });
  }

  // A step's window on `t` (or geq's `T`), shifted back by the same slack the
  // preview's step takes, and a sum over windows that is the hit's value
  // inside it, 0 outside.
  const at = (n: number) => (n - STEP_SLACK).toFixed(5);
  const win = (x: { a: number; b: number }, clock = "t") => `gte(${clock},${at(x.a)})*lt(${clock},${at(x.b)})`;
  const sum = (kinds: GlitchKind[], value: (h: GlitchHit) => number, clock = "t") => {
    const terms = hits.filter((x) => kinds.includes(x.hit.kind)).map((x) => `${fmt(value(x.hit))}*${win(x, clock)}`);
    return terms.length ? terms.join("+") : "0";
  };
  const gateOf = (...kinds: GlitchKind[]) =>
    `enable='gte(t,${edge(start)})*lt(t,${edge(end)})*(${sum(kinds, () => 1)})'`;
  const px = Math.min(width, height);
  const soft = (r: number) => `gblur=sigma=${fmt((r * px) / 1080)}`;
  const lines: string[] = [];

  // Smear: the band the canvas draws, `height / GLITCH_STRETCH` tall and
  // `row * (height - band)` down, scaled back over the whole frame.
  const band = 2 * Math.max(1, Math.round(height / GLITCH_STRETCH / 2));
  lines.push(
    `[${inLabel}]split[gsb${tag}][gss${tag}]`,
    `[gss${tag}]crop=${width}:${band}:0:'(ih-${band})*(${sum(["smear"], (h) => h.row)})',` +
      `scale=${width}:${height},lutyuv=y='(val-minval)*0.6+minval',${soft(1.5)}[gsc${tag}]`,
    `[gsb${tag}][gsc${tag}]overlay=0:0:${gateOf("smear")}:eof_action=pass${chroma.overlay}[gso${tag}]`
  );

  // Tint: the corner the canvas zooms into — the frame's 1/zoom share, as far
  // into the spare room as the focus sits — scaled back to size.
  const cw = 2 * Math.round(width / GLITCH_TINT_ZOOM / 2);
  const ch = 2 * Math.round(height / GLITCH_TINT_ZOOM / 2);
  lines.push(
    `[gso${tag}]split[gtb${tag}][gts${tag}]`,
    `[gts${tag}]crop=${cw}:${ch}:'(iw-${cw})*(${sum(["tint"], (h) => h.focus.x)})':'(ih-${ch})*(${sum(["tint"], (h) => h.focus.y)})',` +
      `scale=${width}:${height},` +
      // The preview's sepia → hue-rotate → saturate → brightness chain as
      // one matrix, applied in RGB.
      `format=${chroma.depth === 10 ? "gbrp10le" : "gbrp"},` +
      `colorchannelmixer=rr=0.147:rg=0.29:rb=0.071:gr=0.275:gg=0.54:gb=0.132:br=0.262:bg=0.517:bb=0.126,` +
      `format=${chroma.pixFmt},${soft(3)}[gtc${tag}]`,
    `[gtb${tag}][gtc${tag}]overlay=0:0:${gateOf("tint")}:eof_action=pass${chroma.overlay}[gto${tag}]`
  );

  // Split: black under the moved copy, the unmoved frame lightened back over
  // it, then the burn — the leak bloom the preview paints, as a radial ramp
  // in plane-relative coordinates so the chroma planes stay in register.
  const big = Math.max(width, height);
  const d = `hypot((X/W-${fmt(GLITCH_BURN.x)})*${fmt(width / big)},(Y/H-${fmt(GLITCH_BURN.y)})*${fmt(height / big)})/0.7`;
  const G = `${fmt(GLITCH_BURN.alpha)}*max(0,1-${d}/0.72)`;
  lines.push(
    `[gto${tag}]split=3[gpb${tag}][gps${tag}][gpo${tag}]`,
    `[gpb${tag}]lutyuv=y='minval':u='(minval+maxval)/2':v='(minval+maxval)/2':${gateOf("split")}[gpk${tag}]`,
    `[gpk${tag}][gps${tag}]overlay=x='${px}*(${sum(["split"], (h) => h.shift)})':y=0:eval=frame:` +
      `${gateOf("split")}:eof_action=pass${chroma.overlay}[gpm${tag}]`,
    `[gpm${tag}][gpo${tag}]blend=c0_mode=lighten:c1_mode=average:c2_mode=average:all_opacity=${fmt(GLITCH_GHOST)}:${gateOf("split")},` +
      `geq=lum='lum(X,Y)+(${code(235, chroma.depth)}-lum(X,Y))*${G}':cb='cb(X,Y)-${code(40, chroma.depth)}*${G}':` +
      `cr='cr(X,Y)+${code(30, chroma.depth)}*${G}':${gateOf("split")},` +
      `noise=alls=28:allf=t+u:${gateOf("smear", "split")}[gpo2${tag}]`
  );

  // Blowout: the preview's brightness and desaturate as one lookup.
  const mid = "(minval+maxval)/2";
  lines.push(
    `[gpo2${tag}]lutyuv=y='clip((val-minval)*2.4+minval,minval,maxval)':` +
      `u='(val-${mid})*0.35+${mid}':v='(val-${mid})*0.35+${mid}':${gateOf("blowout")}[${pin === "rgb" ? `gbo${tag}` : outLabel}]`
  );
  if (pin !== "rgb") {
    return lines;
  }

  // Rgb, pinned only: one channel shift per step, gated to it, since
  // rgbashift takes whole px and no expressions. A 2-frame burst is 1–2.
  const shifts = hits
    .filter((x) => x.hit.kind === "rgb")
    .map((x) => {
      const o = glitchRgb(x.hit);
      const rh = Math.round((o.dx * px) / 1080);
      const rv = Math.round((o.dy * px) / 1080);
      return `rgbashift=rh=${rh}:rv=${rv}:bh=${-rh}:bv=${-rv}:enable='${win(x)}'`;
    });
  lines.push(`[gbo${tag}]${shifts.join(",")}[${outLabel}]`);
  return lines;
}

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
  ramp?: number,
  chroma: ChainChroma = CHROMA_420,
  pulse?: FlashPulse
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
    const lines = lookFilterLines(`lkfi${tag}`, `lkfo${tag}`, look, k, height, chroma.pixFmt, tag, chroma.depth);
    if (!lines) return null;
    return [
      `[${inLabel}]split[lkfb${tag}][lkfi${tag}]`,
      ...lines,
      `[lkfb${tag}][lkfo${tag}]overlay=0:0:${en}:eof_action=pass${chroma.overlay}[${outLabel}]`,
    ];
  }
  const pin = pinnedGlitch(effect);
  if (pin) {
    return glitchFilterLines(inLabel, outLabel, k, start, end, width, height, tag, chroma, pin);
  }
  switch (effect as RecipeId) {
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
          `[efb${tag}][efc${tag}]overlay=0:0:${en}:eof_action=pass${chroma.overlay}[${outLabel}]`,
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
          `${en}:eof_action=pass${chroma.overlay}[${outLabel}]`,
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
      return glitchFilterLines(inLabel, outLabel, k, start, end, width, height, tag, chroma);
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
          `geq=lum='lum(X,Y)+(${code(235, chroma.depth)}-lum(X,Y))*${G}':cb='cb(X,Y)-${code(40, chroma.depth)}*${G}':cr='cr(X,Y)+${code(26, chroma.depth)}*${G}':${en}[${outLabel}]`,
      ];
    }
    case "flash": {
      // A decaying pop from the element start, or the strobe's square pulse,
      // per frame by geq — `T` is the frame's time, so the gain rides every
      // frame of the window. White adds to luma; black pulls every plane
      // toward black at the canvas pass's alpha.
      const rate = flashRate(pulse);
      const p = `((T-${fmt(start)})*${fmt(rate)}+${PULSE_NUDGE})`;
      // A flicker deals each pulse its strength with the same sine hash as
      // `flickerDeal`, held in register 0.
      const deal = `st(0,sin(floor(${p})*12.9898+78.233)*43758.5453);st(0,ld(0)-floor(ld(0)))`;
      const gain = !rate
        ? `exp(-9*(T-${fmt(start)}))`
        : pulse?.rhythm === "flicker"
          ? `(${deal};lt(mod(${p},1),0.5)*gte(ld(0),${FLICKER_SKIP})*ld(0))`
          : `lt(mod(${p},1),0.5)`;
      if (pulse?.tone === "black") {
        const keep = `(1-min(1,${fmt(0.85 * k)}*${gain}))`;
        const mid = code(128, chroma.depth);
        return [
          `[${inLabel}]geq=lum='${code(16, chroma.depth)}+(lum(X,Y)-${code(16, chroma.depth)})*${keep}':` +
            `cb='${mid}+(cb(X,Y)-${mid})*${keep}':cr='${mid}+(cr(X,Y)-${mid})*${keep}':${en}[${outLabel}]`,
        ];
      }
      return [
        `[${inLabel}]geq=lum='min(${code(235, chroma.depth)},lum(X,Y)+${code(200 * k, chroma.depth)}*${gain})':` +
          `cb='cb(X,Y)':cr='cr(X,Y)':${en}[${outLabel}]`,
      ];
    }
    case "burn":
      return burnFilterLines(inLabel, outLabel, k, start, end, chroma);
    case "scorch":
      return scorchFilterLines(inLabel, outLabel, k, start, end, tag, chroma);
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
        `[efb${tag}][efc${tag}]overlay=0:0:${en}:eof_action=pass${chroma.overlay}[${outLabel}]`,
      ];
    }
    case "negative":
      // Each plane flips about its own legal range, so black and white swap
      // exactly in a limited-range chain and the chroma mirrors about grey.
      return [
        `[${inLabel}]lutyuv=y='minval+maxval-val':u='minval+maxval-val':v='minval+maxval-val':${en}[${outLabel}]`,
      ];
    case "huecycle":
      // The canvas recipe's turning wheel, in radians on the frame's clock.
      return [`[${inLabel}]hue=H='2*PI*${fmt(hueTurns(k))}*(t-${fmt(start)})':${en}[${outLabel}]`];
    default:
      return null;
  }
}

/** Steps a second the export's burn is drawn at: one per frame at 60 fps. */
const BURN_RATE = 60;

/** An 8-bit color as limited-range BT.709 Y, Cb, Cr at the chain's depth. */
function yuvCodes(c: [number, number, number], depth: 8 | 10 | undefined): [string, string, string] {
  const [r, g, b] = c.map((v) => v / 255);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [code(16 + 219 * y, depth), code(128 + (224 * (b - y)) / 1.8556, depth), code(128 + (224 * (r - y)) / 1.5748, depth)];
}

/**
 * The burn in ffmpeg: the element is cut into steps of `1 / BURN_RATE`
 * seconds, and one geq draws each step as the preview has it at the step's
 * start — the same stops down the frame, the same flame band across it.
 * Every term is a ratio of the plane's W and H, so the subsampled chroma
 * planes stay in register with luma.
 */
/**
 * The scorch, a light leak's third course: a film burn flashing through the
 * picture. Each frame is dealt one hot tone and a reach — the whole frame or
 * a soft-edged patch of it — and the picture under the reach is mapped onto
 * the tone by brightness: its darks lift to the tone's deep color, its
 * brights to its pale one. The map is a saturation, a screen and a multiply
 * wash, laid in that order by the preview, the in-tab export and an ffmpeg
 * geq alike, so every renderer lands on the same colors, rims included.
 * Amount is the washes' alpha.
 */
const SCORCH_RATE = 30;

/** One hot tone: how often it is dealt, and its deep and pale colors. */
interface ScorchTone {
  weight: number;
  dark: [number, number, number];
  light: [number, number, number];
}

/** Saturated yellow, orange, and red over pink: the narrow, hot ranges of
 * film burn, where the picture shows only as a shade. */
const SCORCH_TONES: ScorchTone[] = [
  { weight: 0.45, dark: [244, 212, 40], light: [248, 238, 130] },
  { weight: 0.35, dark: [240, 105, 25], light: [250, 180, 110] },
  { weight: 0.2, dark: [165, 32, 16], light: [235, 140, 120] },
];

/** The share of frames that burn the whole picture; the rest burn a patch. */
const SCORCH_FULL = 0.35;

/** How much of a patch's radius burns at full strength before its rim. */
const SCORCH_INNER = 0.85;


/** The patch a frame step burns, none for the whole frame: a band wider
 * than the frame sitting high, e.g. centered at (0.5, 0.3) reaching 0.9
 * across and 0.45 down. */
function scorchArea(step: number): WashArea | undefined {
  if (scorchDeal(step, 12) < SCORCH_FULL) {
    return undefined;
  }
  return {
    x: 0.2 + 0.6 * scorchDeal(step, 13),
    y: 0.1 + 0.5 * scorchDeal(step, 14),
    rx: 0.6 + 0.5 * scorchDeal(step, 15),
    ry: 0.3 + 0.25 * scorchDeal(step, 16),
    inner: SCORCH_INNER,
  };
}

/** The luma a saturation blend keeps: CSS and canvas compositing weigh
 * red, green and blue this way. */
const BLEND_LUMA = [0.3, 0.59, 0.11];

/** A scorch step's deal on one channel, 0..1: a sine hash ffmpeg's
 * expressions spell the same way, so the export deals each step itself. */
const DEAL = { a: 12.9898, b: 78.233, m: 43758.5453 };
function scorchDeal(step: number, salt: number): number {
  const v = Math.sin(step * DEAL.a + salt * DEAL.b) * DEAL.m;
  return v - Math.floor(v);
}

/** The frame step `tLocal` seconds in falls in, and the tone it is dealt. */
const scorchStep = (tLocal: number) => Math.floor((tLocal + STEP_SLACK) * SCORCH_RATE);
function scorchTone(step: number): number {
  let pick = scorchDeal(step, 11);
  const i = SCORCH_TONES.findIndex((t) => (pick -= t.weight) < 0);
  return i < 0 ? SCORCH_TONES.length - 1 : i;
}

/** A tone's screen color: its deep color over its pale one, so black
 * screened to it and multiplied by the pale color lands on the deep one,
 * e.g. deep 160 and pale 245 → 167. Screening first keeps a patch's rim
 * from darkening: a wash order that multiplies first dims whites halfway
 * down the ramp. */
const scorchScreen = (t: ScorchTone): [number, number, number] =>
  t.dark.map((d, c) => Math.round((255 * d) / Math.max(1, t.light[c]))) as [number, number, number];

const hex = (rgb: [number, number, number]) =>
  `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

/** The preview and canvas state of one scorched frame. */
function scorchState(tLocal: number, k: number): EffectPreviewState {
  const step = scorchStep(tLocal);
  const tone = SCORCH_TONES[scorchTone(step)];
  const area = scorchArea(step);
  return {
    cssFilter: "",
    washes: [
      { color: "#808080", alpha: k, mode: "saturation", area },
      { color: hex(scorchScreen(tone)), alpha: k, mode: "screen", area },
      { color: hex(tone.light), alpha: k, mode: "multiply", area },
    ],
  };
}

/** The scorch in ffmpeg: on its own branch in RGB, one geq lays each frame
 * step's three washes in the order the canvas does — the saturation to luma,
 * the screen, the multiply — each at the patch's ramp times the amount, so
 * rims blend as they do in the preview. Each slice deals its step from `T`
 * once a frame into registers the wash math reads, so the expression is the
 * same size however long the element runs. */
function scorchFilterLines(
  inLabel: string,
  outLabel: string,
  k: number,
  start: number,
  end: number,
  tag: string,
  chroma: ChainChroma
): string[] {
  const at = (n: number) => (n - STEP_SLACK).toFixed(5);
  const max = chroma.depth === 10 ? 1023 : 255;
  if (end <= start) {
    return [`[${inLabel}]null[${outLabel}]`];
  }

  // Register 9 holds the frame time the registers were dealt for, plus one,
  // so a fresh slice (0) deals. While dealing, register 1 holds the step and
  // a deal spells scorchDeal, scratching in register 0.
  const deal = (salt: number) => `(st(0,sin(ld(1)*${DEAL.a}+${salt * DEAL.b})*${DEAL.m});ld(0)-floor(ld(0)))`;

  // Registers 3–6: the patch's center and radii; a full-frame wash stores
  // radius 0. Registers 7–8 per channel: the tone's screen and multiply
  // colors, 0..1, picked as scorchTone does.
  const patch =
    `if(lt(${deal(12)},${SCORCH_FULL}),st(5,0),` +
    `st(3,0.2+0.6*${deal(13)});st(4,0.1+0.5*${deal(14)});st(5,0.6+0.5*${deal(15)});st(6,0.3+0.25*${deal(16)}))`;
  const pick = (value: (t: ScorchTone) => number) => {
    let left = "ld(0)";
    const branch = (i: number): string => {
      if (i === SCORCH_TONES.length - 1) {
        return fmt(value(SCORCH_TONES[i]));
      }
      left = `${left}-${SCORCH_TONES[i].weight}`;
      return `if(lt(${left},0),${fmt(value(SCORCH_TONES[i]))},${branch(i + 1)})`;
    };
    return branch(0);
  };
  const dealt = (c: number) =>
    `if(eq(ld(9),T+1),0,st(9,T+1);st(1,floor((T-${start}+${STEP_SLACK})*${SCORCH_RATE}));${patch};st(0,${deal(11)});` +
    `st(7,${pick((t) => scorchScreen(t)[c] / 255)});st(8,${pick((t) => t.light[c] / 255)}))`;

  // Register 0: the wash alpha, the amount — times, on a patch, its ramp: 1
  // inside `inner` of the radius, 0 past the rim, at pixel centers like the
  // canvas gradient. Register 1: the blend luma, 0..1.
  const q = `hypot(((X+0.5)/W-ld(3))/ld(5),((Y+0.5)/H-ld(4))/ld(6))`;
  const alpha = `if(ld(5),${fmt(k)}*clip((1-${q})/${fmt(1 - SCORCH_INNER)},0,1),${fmt(k)})`;
  const luma = BLEND_LUMA.map((w, c) => `${fmt(w)}*${"rgb"[c]}(X,Y)`).join("+");

  // Register 2 per channel: the saturation, then the screen, then the
  // multiply, each at the wash alpha.
  const plane = (c: number) =>
    `${dealt(c)};st(0,${alpha});st(1,(${luma})/${max});` +
    `st(2,(1-ld(0))*${"rgb"[c]}(X,Y)/${max}+ld(0)*ld(1));` +
    `st(2,ld(2)+ld(0)*ld(7)*(1-ld(2)));` +
    `${max}*ld(2)*(1-ld(0)+ld(0)*ld(8))`;
  const all = `enable='gte(t,${at(start)})*lt(t,${at(end)})'`;
  const rgb = chroma.depth === 10 ? "gbrp10le" : "gbrp";
  return [
    `[${inLabel}]split[scb${tag}][scs${tag}]`,
    `[scs${tag}]format=${rgb},geq=r='${plane(0)}':g='${plane(1)}':b='${plane(2)}':${all},format=${chroma.pixFmt}[scc${tag}]`,
    `[scb${tag}][scc${tag}]overlay=0:0:${all}:eof_action=pass${chroma.overlay}[${outLabel}]`,
  ];
}

function burnFilterLines(
  inLabel: string,
  outLabel: string,
  k: number,
  start: number,
  end: number,
  chroma: ChainChroma
): string[] {
  const dur = Math.max(end - start, 1e-3);
  const smooth = (x: string) => `(st(1,clip(${x},0,1));ld(1)*ld(1)*(3-2*ld(1)))`;
  const [flare, yellow, orange, edge, flame] = [BURN_FLARE, BURN_YELLOW, BURN_ORANGE, BURN_EDGE, BURN_FLAME].map((c) =>
    yuvCodes(c, chroma.depth).map(Number)
  );
  const S = BURN_STREAK;

  // A slice works out its step's burn from `T` once a frame, as burnAt does
  // at the step's start: register 4 the front's height, 5 the body color,
  // 6 the alpha, 7 the band's progress, 8 the band's opacity (0 off its
  // run), 9 the frame time plus one, so a fresh slice (0) deals.
  const now = `floor((T-${start}+${STEP_SLACK})*${BURN_RATE})`;
  const step = (p: 0 | 1 | 2) => {
    const core =
      `if(lt(ld(0),0.4),${fmt(flare[p])},if(lt(ld(0),0.6),` +
      `${fmt(flare[p])}+${fmt(yellow[p] - flare[p])}*${smooth("(ld(0)-0.4)/0.2")},` +
      `${fmt(yellow[p])}+${fmt(orange[p] - yellow[p])}*${smooth("(ld(0)-0.6)/0.25")}))`;
    return (
      `if(eq(ld(9),T+1),0,st(9,T+1);st(0,clip(${now}/${BURN_RATE}/${dur},0,1));` +
      `st(4,${1 + BURN_GLOW + BURN_EDGE_W}*${smooth(`ld(0)/${BURN_RISE}`)});st(5,${core});` +
      `st(6,${0.7 + 0.3 * k}*(1-${smooth(`(ld(0)-${BURN_RELEASE})/${1 - BURN_RELEASE}`)}));` +
      `st(7,(ld(0)-${S.from})/${S.span});st(8,if(gt(ld(7),0)*lt(ld(7),1),${S.alpha}*sin(PI*ld(7))*ld(6),0)))`
    );
  };

  // Body: the stops as one piecewise ramp in d (register 0), the height from
  // the bottom edge — the body color to the front's body depth, blending to
  // the hot edge, which fades out over its glow — stored as opacity
  // (register 1) and plane value (register 2).
  const plane = (p: 0 | 1 | 2) => {
    const src = ["lum", "cb", "cr"][p];
    const body = `ld(4)-${BURN_BODY}`;
    const rim = `ld(4)-${BURN_EDGE_W}`;
    let e =
      `st(0,1-Y/H);` +
      `st(1,ld(6)*if(lt(ld(0),${rim}),1,max(0,1-(ld(0)-(${rim}))/${BURN_GLOW + BURN_EDGE_W})));` +
      `st(2,if(lt(ld(0),${body}),ld(5),if(lt(ld(0),${rim}),ld(5)+(${fmt(edge[p])}-ld(5))*(ld(0)-(${body}))/${BURN_BODY - BURN_EDGE_W},${fmt(edge[p])})));` +
      `st(3,${src}(X,Y)+(ld(2)-${src}(X,Y))*ld(1))`;

    // The flame band: the canvas's three-stop ramp is a triangle along its
    // axis, peaking at the band's center.
    const th = (S.angle * Math.PI) / 180;
    const len = `(W*${fmt(Math.abs(Math.sin(th)))}+H*${fmt(Math.abs(Math.cos(th)))})`;
    const q = `((X-W/2)*${fmt(Math.sin(th))}+(Y-H/2)*${fmt(-Math.cos(th))})/${len}+0.5`;
    const tri = `max(0,1-abs(${q}-(${S.p0}-${S.travel}*ld(7)))/${fmt(2 * S.w)})`;
    e += `;if(ld(8),st(3,ld(3)+(${fmt(flame[p])}-ld(3))*ld(8)*${tri}),0)`;

    // A step whose burn has faded out leaves the picture as it is.
    return `${step(p)};if(lte(ld(6),0.001),${src}(X,Y),${e};ld(3))`;
  };
  const win = `enable='gte(t,${fmt(start)})*lt(t,${fmt(end)})'`;
  return [`[${inLabel}]geq=lum='${plane(0)}':cb='${plane(1)}':cr='${plane(2)}':${win}[${outLabel}]`];
}
