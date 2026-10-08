/**
 * Text textures: grain laid into the type itself, letter by letter.
 *
 * A texture is one small tile stretched over every glyph's box — the advance
 * width by the line height — so each letter wears the same grain whatever its
 * size. The DOM preview hands the tile to each glyph span as its mask-image;
 * the canvas painter draws the tile's holes out of each glyph with
 * `destination-out`. Both read the one tile, so the speckle lands on the same
 * pixels in the preview and every export.
 */

/** The textures a title can wear. `stipple` is spray-paint grain: each letter
 * breaks into scattered specks along its left edge and runs solid by its
 * middle. */
export const TEXT_TEXTURES = ["stipple"] as const;
export type TextTexture = (typeof TEXT_TEXTURES)[number];

/** Which half of the tile a renderer wants: the ink a mask keeps, or the holes
 * a painter cuts out. */
export type TexturePart = "keep" | "holes";

/** Tile size in texels. Stretched over a 1080-frame letter, a texel lands at
 * about 2–3 px, the grain the template prints. */
const TILE_W = 64;
const TILE_H = 80;

/** A deterministic 0..1 draw per texel, so every render speckles alike. */
function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise over 8-texel cells: the clumps the specks gather in. */
function clump(x: number, y: number): number {
  const cx = Math.floor(x / 8);
  const cy = Math.floor(y / 8);
  const fx = (x % 8) / 8;
  const fy = (y % 8) / 8;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(cx, cy, 7) + (hash(cx + 1, cy, 7) - hash(cx, cy, 7)) * sx;
  const b = hash(cx, cy + 1, 7) + (hash(cx + 1, cy + 1, 7) - hash(cx, cy + 1, 7)) * sx;
  return a + (b - a) * sy;
}

/** How much ink survives at `u` across the letter, 0 at its left edge: a
 * sparse spray that fills in to nearly solid by the middle. */
function stippleDensity(u: number): number {
  const s = Math.min(1, Math.max(0, u / 0.55));
  return Math.min(0.97, 0.16 + 0.82 * s * s * (3 - 2 * s));
}

/** Whether texel (x, y) of the stipple keeps its ink. */
export function stippleKeeps(x: number, y: number): boolean {
  const grain = 0.7 * hash(x, y, 1) + 0.3 * clump(x, y);
  return grain < stippleDensity((x + 0.5) / TILE_W);
}

/** Where tiles are painted: the canvas maker, and the object that owns it (a
 * render env), which the cache is kept on. */
export interface TextureSurface {
  owner: object;
  make: (w: number, h: number) => HTMLCanvasElement;
}

/** Painted tiles, one set per owner: a tab and a render worker each draw on
 * their own surface, and a picture from one cannot be drawn on the other. Two
 * small tiles per owner and one per erosion step, so the cache needs no
 * bound. */
const tiles = new WeakMap<object, Map<string, HTMLCanvasElement>>();

/** The texture's tile, white where the part is. */
export function textureTile(texture: TextTexture, part: TexturePart, surface: TextureSurface): HTMLCanvasElement {
  let byPart = tiles.get(surface.owner);
  if (!byPart) {
    byPart = new Map();
    tiles.set(surface.owner, byPart);
  }
  const key = `${texture}:${part}`;
  const cached = byPart.get(key);
  if (cached) {
    return cached;
  }

  // One texel per pixel: opaque white where the part is, clear elsewhere.
  const canvas = surface.make(TILE_W, TILE_H);
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(TILE_W, TILE_H);
  for (let y = 0; y < TILE_H; y++) {
    for (let x = 0; x < TILE_W; x++) {
      const on = stippleKeeps(x, y) === (part === "keep");
      const i = (y * TILE_W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = on ? 255 : 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  byPart.set(key, canvas);
  return canvas;
}

/** Cut a texture out of the glyph just drawn: the tile's holes, stretched over
 * the glyph's box (`x, y, w, h` in the current transform) and clipped to it,
 * so the letters beside it keep their ink. */
export function cutTexture(
  ctx: CanvasRenderingContext2D,
  texture: TextTexture,
  surface: TextureSurface,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = 1;
  ctx.shadowColor = "transparent";
  ctx.drawImage(textureTile(texture, "holes", surface), x, y, w, h);
  ctx.restore();
}

/** The erosion tile's size in texels; stretched over the element's box. */
const ERODE_W = 160;
const ERODE_H = 80;
/** Erosion steps a renderer draws: a frame's share is rounded to one of
 * these, so each step's tile is painted once and reused. */
const ERODE_LEVELS = 24;
/** The soft band at the edge of the eaten grain, in field units. */
const ERODE_EDGE = 0.05;

/** Value noise over `cell`-texel cells, seeded per octave. */
function cellNoise(x: number, y: number, cell: number, seed: number): number {
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  const fx = (x % cell) / cell;
  const fy = (y % cell) / cell;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(cx, cy, seed) + (hash(cx + 1, cy, seed) - hash(cx, cy, seed)) * sx;
  const b = hash(cx, cy + 1, seed) + (hash(cx + 1, cy + 1, seed) - hash(cx, cy + 1, seed)) * sx;
  return a + (b - a) * sy;
}

/** The order the ink goes in: blotches at three scales over a fine grain,
 * flattened to ranks so a share of `e` eats exactly that share of the box. */
let erodeField: Float32Array | null = null;
function erosionField(): Float32Array {
  if (erodeField) {
    return erodeField;
  }
  const n = ERODE_W * ERODE_H;
  const raw = new Float32Array(n);
  for (let y = 0; y < ERODE_H; y++) {
    for (let x = 0; x < ERODE_W; x++) {
      const blot = 0.5 * cellNoise(x, y, 20, 11) + 0.3 * cellNoise(x, y, 8, 12) + 0.2 * cellNoise(x, y, 3, 13);
      raw[y * ERODE_W + x] = 0.75 * blot + 0.25 * hash(x, y, 14);
    }
  }
  const order = [...raw.keys()].sort((a, b) => raw[a] - raw[b]);
  const field = new Float32Array(n);
  order.forEach((i, rank) => {
    field[i] = rank / (n - 1);
  });
  erodeField = field;
  return field;
}

/** The erosion step a share `erode` of the ink eaten draws at, 0 (whole)
 * through `erodeLevel(1)` (gone): pictures of one step look the same. */
export const erodeLevel = (erode: number) => Math.round(Math.min(1, Math.max(0, erode)) * ERODE_LEVELS);

/** The erosion tile for a share `erode` of the ink eaten, white where the
 * part is: `keep` for a DOM mask, `holes` for a canvas cut. */
export function erodeTile(erode: number, part: TexturePart, surface: TextureSurface): HTMLCanvasElement {
  const level = erodeLevel(erode);
  let byPart = tiles.get(surface.owner);
  if (!byPart) {
    byPart = new Map();
    tiles.set(surface.owner, byPart);
  }
  const key = `erode:${level}:${part}`;
  const cached = byPart.get(key);
  if (cached) {
    return cached;
  }

  // Ink keeps where its rank is past the eaten share, through a soft band.
  const e = level / ERODE_LEVELS;
  const field = erosionField();
  const canvas = surface.make(ERODE_W, ERODE_H);
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(ERODE_W, ERODE_H);
  for (let i = 0; i < field.length; i++) {
    const keep = Math.min(1, Math.max(0, (field[i] - e) / ERODE_EDGE + 0.5));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = Math.round(255 * (part === "keep" ? keep : 1 - keep));
  }
  ctx.putImageData(img, 0, 0);
  byPart.set(key, canvas);
  return canvas;
}
