/** Preset filter looks: a named color/effect treatment baked over a clip's
 * picture in both preview and export. */
import { kitCanvas } from "./surface";

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

/**
 * Preset filter looks, one recipe per style with two renderers — the preview
 * canvas (a CSS filter string plus post passes: vignette, grain, glow, color
 * washes, chroma ghosts) and the export filtergraph (an ffmpeg chain built
 * server-side from the same `amount` knob). Both sides interpolate the same
 * conceptual parameters toward identity as the amount drops, so 30% reads the
 * same in the editor and the rendered file.
 *
 * Known approximations, accepted by design: blockbuster's shadow/highlight
 * split-toning previews as two soft-light washes (CSS has no per-luminance
 * masking); VHS chroma fringing previews as tinted ghost copies rather than a
 * true channel shift; tech's unsharp crispness is export-only.
 */

const clampAmount = (k: number | undefined) => Math.max(0.05, Math.min(1, k ?? 1));

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();

/* ---------------------------------------------------------------- canvas */

/** `ctx.filter` value for the clip's base grading pass; "" when none. */
export function lookCssFilter(style: LookStyle | undefined, amount?: number): string {
  if (!style) return "";
  const k = clampAmount(amount);
  switch (style) {
    case "vintage":
      return `sepia(${fmt(0.25 * k)}) saturate(${fmt(1 - 0.15 * k)}) contrast(${fmt(1 - 0.08 * k)}) brightness(1.03)`;
    case "vhs":
      return `saturate(${fmt(1 - 0.35 * k)}) contrast(${fmt(1 - 0.05 * k)}) blur(${fmt(0.6 * k)}px)`;
    case "horror":
      return `grayscale(${fmt(0.55 * k)}) brightness(${fmt(1 - 0.12 * k)}) contrast(${fmt(1 + 0.1 * k)})`;
    case "halation":
      return `saturate(${fmt(1 + 0.05 * k)})`;
    case "tech":
      return `contrast(${fmt(1 + 0.12 * k)}) saturate(${fmt(1 + 0.08 * k)})`;
    case "noir":
      return `grayscale(${fmt(k)}) contrast(${fmt(1 + 0.08 * k)})`;
    case "grain":
      return "";
    case "pastel":
      return `brightness(${fmt(1 + 0.06 * k)}) contrast(${fmt(1 - 0.15 * k)}) saturate(${fmt(1 - 0.18 * k)})`;
    case "blockbuster":
      return `contrast(${fmt(1 + 0.1 * k)}) saturate(${fmt(1 + 0.15 * k)})`;
    case "dreamy":
      return `brightness(1.02) saturate(${fmt(1 + 0.05 * k)})`;
  }
}

/** Post passes drawn over the clip's footprint after its graded picture. */
export interface LookPost {
  /** Radial corner-darkening strength 0..1. */
  vignette?: number;
  /** Animated noise-tile overlay alpha 0..1. */
  grain?: number;
  /** Self-copy glow: blur radius as a fraction of the frame height, blended
   * back over the picture. `bright` isolates highlights first (halation). */
  glow?: { blurFrac: number; alpha: number; mode: "screen" | "lighten"; bright?: boolean };
  /** Flat color layers composited over the picture. */
  washes?: { color: string; alpha: number; mode: GlobalCompositeOperation }[];
  /** VHS-style chroma fringing: tinted copies offset horizontally by a
   * fraction of the frame width. */
  ghost?: { shiftFrac: number; alpha: number };
}

export function lookPost(style: LookStyle | undefined, amount?: number): LookPost | null {
  if (!style) return null;
  const k = clampAmount(amount);
  switch (style) {
    case "vintage":
      return { vignette: 0.35 * k, grain: 0.05 * k };
    case "vhs":
      return { grain: 0.09 * k, ghost: { shiftFrac: 0.004 * k, alpha: 0.35 * k } };
    case "horror":
      return { vignette: 0.55 * k, grain: 0.14 * k };
    case "halation":
      return { glow: { blurFrac: 14 / 1920, alpha: 0.6 * k, mode: "screen", bright: true } };
    case "tech":
      return { washes: [{ color: "#3b9dff", alpha: 0.1 * k, mode: "soft-light" }] };
    case "noir":
      return { grain: 0.06 * k };
    case "grain":
      return { grain: 0.04 + 0.12 * k };
    case "pastel":
      return null;
    case "blockbuster":
      return {
        washes: [
          { color: "#ff9a3c", alpha: 0.12 * k, mode: "soft-light" },
          { color: "#0e7490", alpha: 0.08 * k, mode: "overlay" },
        ],
      };
    case "dreamy":
      return { glow: { blurFrac: 10 / 1920, alpha: 0.45 * k, mode: "lighten" } };
  }
}

/** Pre-rendered grain tiles, cycled per frame for shimmer. The grain follows
 * filmgrainer's model of film response (github.com/larspontoppidan/filmgrainer):
 * gaussian noise about mid-gray, generated coarse
 * and upscaled with smoothing so grains clump like crystals, and laid over the
 * picture with the overlay blend, which holds grain in the midtones and lets
 * it sink into deep shadows and highlights. Built once on first use (client
 * only) — never per-frame pixel work. */
const GRAIN_TILE = 256;
const GRAIN_COUNT = 3;
/** Std dev of the gaussian noise about 128 — filmgrainer's "power". */
const GRAIN_SD = 50;
/** Grain coarseness: the noise is generated this many times smaller than the
 * tile and upscaled smooth, so a grain spans a couple of pixels. */
const GRAIN_SIZE = 1.6;
let grainTiles: HTMLCanvasElement[] | null = null;

export function grainTile(tick: number): HTMLCanvasElement | null {
  if (!grainTiles) {
    grainTiles = [];
    const side = Math.round(GRAIN_TILE / GRAIN_SIZE);
    for (let n = 0; n < GRAIN_COUNT; n++) {
      const small = kitCanvas(side, side);
      const sctx = small.getContext("2d");
      if (!sctx) return null;
      const img = sctx.createImageData(side, side);
      for (let i = 0; i < img.data.length; i += 4) {
        // Box–Muller gaussian, clipped to 8-bit.
        const g =
          128 +
          GRAIN_SD *
            Math.sqrt(-2 * Math.log(1 - Math.random())) *
            Math.cos(2 * Math.PI * Math.random());
        const v = Math.max(0, Math.min(255, Math.round(g)));
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      sctx.putImageData(img, 0, 0);
      const c = kitCanvas(GRAIN_TILE, GRAIN_TILE);
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(small, 0, 0, GRAIN_TILE, GRAIN_TILE);
      grainTiles.push(c);
    }
  }
  return grainTiles[(tick >> 1) % GRAIN_COUNT];
}

let grainUrl: string | null = null;

/** The first grain tile as a data URL, for the DOM surfaces that paint grain
 * with CSS — the preview stage and the effect tiles. Overlay-blend it and set
 * the layer's opacity to the effect's grain amount. */
export function grainTileUrl(): string | null {
  if (typeof document === "undefined") return null; // a CSS surface, page only
  if (grainUrl) return grainUrl;
  const tile = grainTile(0);
  if (!tile) return null;
  grainUrl = tile.toDataURL("image/png");
  return grainUrl;
}

/* ---------------------------------------------------------------- ffmpeg */

const PI = Math.PI;

/** Single-chain looks: the filter run (no leading label, no trailing format). */
function lookChain(style: LookStyle, k: number): string | null {
  switch (style) {
    case "vintage":
      return (
        `curves=master='0/${fmt(0.06 * k)} 0.5/${fmt(0.5 + 0.02 * k)} 1/${fmt(1 - 0.05 * k)}'` +
        `:r='0/${fmt(0.02 * k)} 1/1':b='0/0 1/${fmt(1 - 0.1 * k)}',` +
        `colortemperature=temperature=${Math.round(6500 - 1800 * k)},` +
        `vibrance=intensity=${fmt(-0.25 * k)},` +
        `vignette=angle=${fmt((k * PI) / 5)},` +
        `noise=alls=${Math.round(6 * k)}:allf=t+u`
      );
    case "vhs":
      return (
        `rgbashift=rh=${Math.round(3 * k)}:bh=${-Math.round(3 * k)},` +
        `hue=s=${fmt(1 - 0.4 * k)},` +
        `gblur=sigma=${fmt(0.8 * k)},` +
        `curves=master='0/${fmt(0.04 * k)} 1/${fmt(1 - 0.07 * k)}',` +
        `noise=alls=${Math.round(14 * k)}:allf=t+u`
      );
    case "horror":
      return (
        `huesaturation=saturation=${fmt(-0.6 * k)}:intensity=${fmt(-0.15 * k)},` +
        `curves=master='0/0 0.5/${fmt(0.5 - 0.08 * k)} 1/${fmt(1 - 0.1 * k)}',` +
        `vignette=angle=${fmt((k * PI) / 3.5)},` +
        `noise=alls=${Math.round(22 * k)}:allf=t+u`
      );
    case "tech":
      return (
        `colortemperature=temperature=${Math.round(6500 + 3500 * k)},` +
        `curves=master='0/0 0.5/${fmt(0.5 - 0.02 * k)} 1/1',` +
        `vibrance=intensity=${fmt(0.15 * k)},` +
        `unsharp=5:5:${fmt(0.8 * k)}`
      );
    case "noir":
      return (
        `hue=s=${fmt(1 - k)},` +
        `curves=master='0/0 0.5/${fmt(0.5 - 0.03 * k)} 1/1',` +
        `noise=alls=${Math.round(8 * k)}:allf=t+u`
      );
    case "grain":
      return `noise=alls=${Math.round(4 + 16 * k)}:allf=t+u`;
    case "pastel":
      return (
        `curves=master='0/${fmt(0.09 * k)} 1/${fmt(1 - 0.06 * k)}',` +
        `vibrance=intensity=${fmt(-0.2 * k)},` +
        `colortemperature=temperature=${Math.round(6500 - 800 * k)}`
      );
    case "blockbuster":
      return (
        `colorbalance=rs=${fmt(-0.1 * k)}:bs=${fmt(0.15 * k)}` +
        `:rm=${fmt(0.05 * k)}:bm=${fmt(-0.05 * k)}` +
        `:rh=${fmt(0.1 * k)}:bh=${fmt(-0.1 * k)},` +
        `vibrance=intensity=${fmt(0.2 * k)}`
      );
    default:
      return null; // halation and dreamy are split/blend graphs
  }
}

/**
 * ffmpeg filter_complex lines rendering `style` from `[inLabel]` into
 * `[outLabel]`, ending in `format=${pixFmt}` so the segment's format
 * invariant holds through xfade/concat joins. Null for an unknown style — the
 * segment renders ungraded rather than failing the job (the spec carries only
 * ids, never filter text). `hPx` scales blur radii so 720p drafts and 1080p
 * exports bloom proportionally; `tag` uniquifies inner labels.
 */
export function lookFilterLines(
  inLabel: string,
  outLabel: string,
  style: string,
  amount: number | undefined,
  hPx: number,
  pixFmt: string,
  tag: string
): string[] | null {
  const k = clampAmount(amount);
  if (style === "halation") {
    return [
      `[${inLabel}]split=2[lkb${tag}][lkh${tag}]`,
      `[lkh${tag}]lutyuv=y='clip((val-160)*3,0,255)',` +
        `gblur=sigma=${fmt((18 * hPx) / 1920)},` +
        `colorchannelmixer=rr=1:gg=0.55:bb=0.35[lkg${tag}]`,
      `[lkb${tag}][lkg${tag}]blend=all_mode=screen:all_opacity=${fmt(0.6 * k)},format=${pixFmt}[${outLabel}]`,
    ];
  }
  if (style === "dreamy") {
    return [
      `[${inLabel}]split=2[lkb${tag}][lkh${tag}]`,
      `[lkh${tag}]gblur=sigma=${fmt((10 * hPx) / 1920)}[lkg${tag}]`,
      `[lkb${tag}][lkg${tag}]blend=all_mode=lighten:all_opacity=${fmt(0.45 * k)},` +
        `curves=master='0/${fmt(0.03 * k)} 1/${fmt(1 - 0.03 * k)}',` +
        `vibrance=intensity=${fmt(0.1 * k)},format=${pixFmt}[${outLabel}]`,
    ];
  }
  const chain = lookChain(style as LookStyle, k);
  if (!chain) return null;
  return [`[${inLabel}]${chain},format=${pixFmt}[${outLabel}]`];
}
