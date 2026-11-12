/**
 * Film grain: one model the canvas and the ffmpeg graph both draw.
 *
 * Grain is monochrome gaussian noise about mid-gray, made on a grid of cells
 * `GRAIN_GAUGE` across the frame's short side and upscaled bilinear, so each
 * grain is a soft clump a fixed share of the frame at any resolution — a 35mm
 * gauge, about 1.7 px a cell at 1080. It lands with the overlay blend, which
 * holds it in the midtones and lets it fall away into black and white. Every
 * frame wears fresh grain, and its strength is the overlay's opacity, so an
 * opacity of 0 is no grain at all.
 *
 * The canvas draws precomputed tiles: each frame shifts the lattice by its own
 * offset and deals every slot its own tile, so the grain never loops or
 * repeats. ffmpeg makes the same cells per frame from its gaussian noise.
 */
import { kitCanvas } from "./surface";

/** Grain cells across the frame's short side. */
const GRAIN_GAUGE = 640;

/** The smallest cell, in px: a smaller one would land on whole pixels with
 * no upscale to soften it. */
const MIN_CELL = 1.5;

/** A tile's side in cells, and how many tiles the canvas deals from. */
const GRAIN_TILE = 256;
const GRAIN_TILES = 6;

/** Std dev of a cell about mid-gray, in 8-bit codes. */
const GRAIN_SD = 56;

/** Fresh grain this many times a second: every frame of a cut up to 60 fps. */
const GRAIN_RATE = 60;

/** ffmpeg's gaussian `noise` at this strength sits at a mean of 127.7 with a
 * std dev of 18.4 codes (measured); a gain about that mean lifts it to
 * `GRAIN_SD` about mid-gray. */
const NOISE_STRENGTH = 32;
const NOISE_MEAN = 127.7;
const NOISE_SD = 18.4;

/** The tiles' seed, so every session deals the same grain. */
const GRAIN_SEED = 0x9e3779b9;

/** The DOM tile stitches this many canvas tiles a side. */
const URL_TILES = 2;

/** The DOM tile's side, inside a size container the frame fills: its share
 * of the short side (0.8), and never finer than `MIN_CELL` CSS px a cell. */
export const GRAIN_URL_SIDE = `max(${(100 * URL_TILES * GRAIN_TILE) / GRAIN_GAUGE}cqmin, ${URL_TILES * GRAIN_TILE * MIN_CELL}px)`;

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();

/** A grain cell's side in px on a frame whose short side is `shortPx`. */
const cellPx = (shortPx: number) => Math.max(MIN_CELL, shortPx / GRAIN_GAUGE);

/** A uniform hash of two integers into [0, 1). */
function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x632be5ab, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A seeded uniform source (mulberry32), so the tiles are the same grain in
 * every tab and render worker. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let grainTiles: HTMLCanvasElement[] | null = null;

/** Build the tiles once: gaussian cells about mid-gray, one canvas pixel a
 * cell. The upscale happens as they draw. */
function buildTiles(): HTMLCanvasElement[] | null {
  const rand = seeded(GRAIN_SEED);
  const tiles: HTMLCanvasElement[] = [];
  for (let n = 0; n < GRAIN_TILES; n++) {
    const c = kitCanvas(GRAIN_TILE, GRAIN_TILE);
    const ctx = c.getContext("2d");
    if (!ctx) {
      return null;
    }
    const img = ctx.createImageData(GRAIN_TILE, GRAIN_TILE);
    for (let i = 0; i < img.data.length; i += 4) {
      // Box–Muller gaussian, clipped to 8-bit.
      const g = 128 + GRAIN_SD * Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
      const v = Math.max(0, Math.min(255, Math.round(g)));
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    tiles.push(c);
  }
  return tiles;
}

/** Grain tile `n` of the deck (any integer; it wraps). Built once on first
 * use — never per-frame pixel work. */
export function grainTile(n: number): HTMLCanvasElement | null {
  grainTiles ??= buildTiles();
  if (!grainTiles) {
    return null;
  }
  return grainTiles[((n % GRAIN_TILES) + GRAIN_TILES) % GRAIN_TILES];
}

/**
 * Draw the grain over (x, y, w, h) at `t` seconds, in the context's current
 * blend and alpha — the caller sets overlay at the grain's strength. Tiles
 * draw at the cell size of a frame whose short side is `shortPx`, from
 * `tileFor` (`grainTile`, or a stand-in under test).
 */
export function paintGrain(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  shortPx: number,
  t: number,
  tileFor: (n: number) => CanvasImageSource | null
): void {
  const side = Math.max(1, Math.round(GRAIN_TILE * cellPx(shortPx)));
  const tick = Math.floor(t * GRAIN_RATE);

  // Bilinear upscale, the same kernel the export scales its cells with.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "low";

  // The lattice starts at this tick's own offset, and each slot takes its own
  // tile, so neither neighbors nor frames share a pattern. Whole-pixel slots
  // butt together without seams.
  const x0 = Math.floor(x - hash(tick, 1) * side);
  const y0 = Math.floor(y - hash(tick, 2) * side);
  for (let row = 0, ty = y0; ty < y + h; row++, ty += side) {
    for (let col = 0, tx = x0; tx < x + w; col++, tx += side) {
      const tile = tileFor(Math.floor(hash(tick, 3 + col + row * 64) * GRAIN_TILES));
      if (!tile) {
        return;
      }
      ctx.drawImage(tile, tx, ty, side, side);
    }
  }
}

/** Where the DOM tile sits at `t`, as shares of its side: a fresh offset
 * every tick, the canvas lattice's own. */
export function grainShiftAt(t: number): { x: number; y: number } {
  const tick = Math.floor(t * GRAIN_RATE);
  return { x: hash(tick, 1), y: hash(tick, 2) };
}

let grainUrl: string | null = null;

/** The DOM surfaces' grain tile as a data URL: four canvas tiles stitched, so
 * the stage repeats it less than twice across its short side. Size it to
 * `GRAIN_URL_SIDE`, overlay-blend it at the grain's strength, and move it to
 * `grainShiftAt` each frame. */
export function grainTileUrl(): string | null {
  if (typeof document === "undefined") {
    return null; // a CSS surface, page only
  }
  if (grainUrl) {
    return grainUrl;
  }
  const c = kitCanvas(URL_TILES * GRAIN_TILE, URL_TILES * GRAIN_TILE);
  const ctx = c.getContext("2d");
  if (!ctx) {
    return null;
  }
  for (let n = 0; n < URL_TILES * URL_TILES; n++) {
    const tile = grainTile(n);
    if (!tile) {
      return null;
    }
    ctx.drawImage(tile, (n % URL_TILES) * GRAIN_TILE, Math.floor(n / URL_TILES) * GRAIN_TILE);
  }
  grainUrl = c.toDataURL("image/png");
  return grainUrl;
}

/** Pixel formats whose planes are R, G and B. */
const RGB_FORMAT = /^(rgb|bgr|gbr|argb|abgr)/;

/**
 * The grain in ffmpeg: filter lines from `[inLabel]` to `[outLabel]` laying
 * grain at `alpha` over the picture while `enable` holds (a full
 * `enable='…'` option; "" grains every frame). The picture's frame has a
 * short side of `shortPx`; `pixFmt` is the chain's, which the output keeps.
 *
 * The cells come from the picture's own frames, so the layer keeps their
 * timing and never lengthens or cuts the clip: scaled down to the cell grid,
 * set to mid-gray, given gaussian noise on luma (fresh each frame) and the
 * gain to `GRAIN_SD`, then scaled bilinear back to the picture's exact size.
 * A YUV picture blends on luma alone, stretched to full range for the blend
 * so black and white take none, and its chroma passes untouched; an RGB one
 * takes the same grain on every channel, as the canvas does. The cell layer
 * is YUV for a YUV picture and gray for an RGB one, the two conversions that
 * carry its codes over unchanged; it never carries a range tag, which ffmpeg
 * would push back up the graph onto the picture.
 */
export function grainFilterLines(
  inLabel: string,
  outLabel: string,
  alpha: number,
  shortPx: number,
  enable: string,
  tag: string,
  pixFmt: string
): string[] {
  if (alpha <= 0) {
    return [`[${inLabel}]null[${outLabel}]`];
  }
  const cell = fmt(cellPx(shortPx));
  const rgb = RGB_FORMAT.test(pixFmt);
  const on = enable ? `:${enable}` : "";

  // The cell layer: mid-gray, the noise, its gain.
  const flat = rgb ? "format=gray,lut=c0=128" : "format=yuv420p,lutyuv=y=128:u=128:v=128";
  const lines = [
    `[${inLabel}]split[gnp${tag}][gns${tag}]`,
    `[gns${tag}]scale=w='ceil(iw/${cell})':h='ceil(ih/${cell})':flags=neighbor,${flat},` +
      `noise=c0s=${NOISE_STRENGTH}:c0f=t${on},` +
      `lut=c0='clip(128+(val-${NOISE_MEAN})*${fmt(GRAIN_SD / NOISE_SD)}+0.5,0,255)'[gnc${tag}]`,
    `[gnc${tag}][gnp${tag}]scale2ref=w=iw:h=ih:flags=bilinear[gnu${tag}][gnb${tag}]`,
    `[gnu${tag}]format=${pixFmt}[gnl${tag}]`,
  ];
  const opacity = fmt(Math.min(1, alpha));
  if (rgb) {
    lines.push(
      `[gnb${tag}][gnl${tag}]blend=c0_mode=overlay:c1_mode=overlay:c2_mode=overlay:` +
        `c0_opacity=${opacity}:c1_opacity=${opacity}:c2_opacity=${opacity}${on},format=${pixFmt}[${outLabel}]`
    );
    return lines;
  }

  // Luma stretched to full range around the blend, and back; a lookup
  // truncates, so each rounds. The full-range top is spelled from the
  // plane's own legal range — 255 at 8 bits, 1023 at 10, 65535 when ffmpeg
  // widens a plane the lookup cannot take to 16.
  const max = "(maxval+minval*21/16-1)";
  lines.push(
    `[gnb${tag}]lutyuv=y='(val-minval)*${max}/(maxval-minval)+0.5'${on}[gne${tag}]`,
    `[gne${tag}][gnl${tag}]blend=c0_mode=overlay:c0_opacity=${opacity}${on},` +
      `lutyuv=y='val*(maxval-minval)/${max}+minval+0.5'${on},format=${pixFmt}[${outLabel}]`
  );
  return lines;
}
