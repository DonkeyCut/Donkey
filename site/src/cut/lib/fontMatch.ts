/**
 * Which face a piece of type on a reference frame is set in.
 *
 * The reference's ink is lifted off its ground, cut to its bounding box and
 * laid on a small grid; each candidate face sets the same words, its tracking
 * solved so its ink runs as wide for its height as the reference's does, and
 * goes on a grid the same size. The score is how much of the two grids' ink
 * overlaps (soft IoU) times how close their widths come once the tracking is
 * spent, so a condensed face that cannot stretch to a wide line scores low.
 * Every face draws through the raster seam, so the page and a headless job
 * rank alike.
 */

import { ensureFontLoaded, LETTER_SPACING_MAX, LETTER_SPACING_MIN, LINE_HEIGHT, TEXT_WEIGHTS, type TextWeight } from "@donkeycut/effects-kit";
import { GOOGLE_FONTS } from "./fontCatalog";
import { createRasterCanvas, type RasterSurface } from "./raster";
import { allFonts, FONTS, hasFont } from "./types";

/** A face a title can be set in. */
export interface TitleFace {
  font: string;
  weight: TextWeight;
  italic?: boolean;
}

/** A face as it ranks against the reference. */
export interface FaceMatch extends TitleFace {
  /** 0..1: ink overlap times width agreement. */
  score: number;
  /** The letter spacing, em, that runs the face as wide as the reference. */
  tracking: number;
  /** The type size, in the reference's px, that sets its first line's ink
   * as tall as the reference's. */
  typePx: number;
}

/** Pixels in a box. */
export interface InkBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A crop's ink: 1 where type is, 0 where its ground is, and the box the ink
 * fills. */
export interface InkMask {
  w: number;
  h: number;
  ink: Uint8Array;
  box: InkBox | null;
}

/** Type size every candidate is set at, px. */
const PROBE_PX = 64;
/** Grid rows both inks are laid on. */
const GRID_ROWS = 40;
/** A row or column whose ink is under this share of the fullest one is a
 * speck, outside the box. */
const SPECK = 0.02;
/** The upright weights of the system set, which every host draws. */
const BASE_WEIGHTS: Record<string, TextWeight[]> = { impact: [400] };
const BASE_DEFAULT_WEIGHTS: TextWeight[] = [400, 700];

/** Every face this process can draw a title in: the bundled families at their
 * bundled weights (a lighter cut answers to 400, as a title asks for it), the
 * system set, and the account's own fonts. */
export function bundledFaces(): TitleFace[] {
  const asTitle = (w: number) => TEXT_WEIGHTS.find((t) => t >= w) ?? 900;
  const faces: TitleFace[] = [];
  for (const f of FONTS) {
    for (const weight of BASE_WEIGHTS[f.id] ?? BASE_DEFAULT_WEIGHTS) faces.push({ font: f.id, weight });
  }
  for (const f of GOOGLE_FONTS) {
    if (!hasFont(f.id)) {
      continue;
    }
    for (const w of new Set(f.weights.map(asTitle))) faces.push({ font: f.id, weight: w });
    for (const w of new Set((f.italics ?? []).map(asTitle))) faces.push({ font: f.id, weight: w, italic: true });
  }

  // Fonts the account brought: one face each, drawn as the file sets it.
  const known = new Set([...FONTS.map((f) => f.id), ...GOOGLE_FONTS.map((f) => f.id)]);
  for (const f of allFonts()) {
    if (!known.has(f.id)) faces.push({ font: f.id, weight: 400 });
  }
  return faces;
}

/** The ink in an RGBA crop. The ground is the colour its border mostly
 * holds; ink is whatever sits far from it, split at the Otsu threshold of
 * that distance, so light type on dark, dark on light and coloured type all
 * read the same. */
export function inkMaskOf(data: Uint8ClampedArray, w: number, h: number): InkMask {
  const n = w * h;
  const ground = borderMedian(data, w, h);

  // Distance from the ground, 0..255, and its histogram.
  const dist = new Uint8Array(n);
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) {
    const d = Math.max(
      Math.abs(data[i * 4] - ground[0]),
      Math.abs(data[i * 4 + 1] - ground[1]),
      Math.abs(data[i * 4 + 2] - ground[2])
    );
    dist[i] = d;
    hist[d]++;
  }
  const cut = Math.max(24, otsu(hist, n));
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = dist[i] > cut ? 1 : 0;
  return { w, h, ink, box: inkBoxOf(ink, w, h, { x: 0, y: 0, w, h }) };
}

/** Rank `faces` by how closely each sets `text` the way the reference's ink
 * shows it, best first. A text with line breaks is scored line by line
 * against the reference's rows of ink, which have to number the same. */
export async function rankFaces(
  ref: InkMask,
  text: string,
  faces: TitleFace[],
  fontStack: (font: string) => string
): Promise<FaceMatch[]> {
  if (!ref.box) throw new Error("No type stands out from its ground in that region.");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("Pass the words the region shows.");
  const bands = bandsOf(ref, ref.box);
  if (bands.length !== lines.length)
    throw new Error(
      `The region holds ${lines_(bands.length)} of ink and the text has ${lines_(lines.length)}. Pass the text with a line break where the type breaks, or a region around one line.`
    );

  // The reference lines on their grids, once.
  const refs = bands.map((b) => {
    const cols = gridCols(b);
    return { box: b, cols, grid: soften(gridOf(ref.ink, ref.w, b, cols), cols) };
  });
  const widest = Math.max(...bands.map((b) => b.w));

  const inkWidth = bands.reduce((sum, b) => sum + b.w, 0);

  // Each face sets every line; a line counts by how wide its ink runs.
  const probe = new Probe();
  const ranked: FaceMatch[] = [];
  try {
    for (const face of faces) {
      const css = `${face.italic ? "italic " : ""}${face.weight} ${PROBE_PX}px ${fontStack(face.font)}`;
      await ensureFontLoaded(css, lines.join(" "));
      let score = 0;
      let tracking = 0;
      let typePx = 0;
      for (let i = 0; i < lines.length; i++) {
        const m = fitLine(probe, css, lines[i], refs[i]);
        score += (m.score * refs[i].box.w) / inkWidth;
        if (refs[i].box.w === widest) tracking = m.tracking;
        if (i === 0 && m.inkPerPx > 0) typePx = refs[0].box.h / m.inkPerPx;
      }
      ranked.push({ ...face, score: Math.round(score * 1000) / 1000, tracking: Math.round(tracking * 1000) / 1000, typePx });
    }
  } finally {
    probe.close();
  }
  return ranked.sort((a, b) => b.score - a.score);
}

/** How far a title's ink centre sits from the point it is set at, px, the
 * type upright: each line centred on x and stacked about y on the middle
 * baseline, as the kit draws it. Caps stand above that baseline, and a
 * browser counts tracking after the last letter, so the ink is off the
 * point; a title set at the reference ink's centre less this lands on it. */
export async function inkOffset(
  face: TitleFace,
  px: number,
  tracking: number,
  text: string,
  fontStack: (font: string) => string
): Promise<{ dx: number; dy: number } | null> {
  const lines = text.split("\n");
  const css = `${face.italic ? "italic " : ""}${face.weight} ${px}px ${fontStack(face.font)}`;
  await ensureFontLoaded(css, text);
  const lineH = px * LINE_HEIGHT;
  const w = Math.ceil(px * (Math.max(...lines.map((l) => [...l].length)) * (1.4 + Math.max(0, tracking)) + 2));
  const h = Math.ceil(lineH * lines.length + px * 2);
  const canvas = createRasterCanvas(w, h);
  try {
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.font = css;
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${tracking * px}px`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    lines.forEach((line, i) => ctx.fillText(line, w / 2, h / 2 - (lineH * lines.length) / 2 + lineH * (i + 0.5)));
    const data = ctx.getImageData(0, 0, w, h).data;
    const ink = new Uint8Array(w * h);
    for (let i = 0; i < ink.length; i++) ink[i] = data[i * 4 + 3] > 127 ? 1 : 0;
    const box = inkBoxOf(ink, w, h, { x: 0, y: 0, w, h });
    return box ? { dx: box.x + box.w / 2 - w / 2, dy: box.y + box.h / 2 - h / 2 } : null;
  } finally {
    canvas.width = 0;
  }
}

/** One line set in one face against one reference line: tracking solved
 * from the width its ink runs at tracking 0. */
function fitLine(
  probe: Probe,
  css: string,
  line: string,
  ref: { box: InkBox; cols: number; grid: Float32Array }
): { score: number; tracking: number; inkPerPx: number } {
  const flat = probe.set(css, line, 0);
  if (!flat) return { score: 0, tracking: 0, inkPerPx: 0 };

  // Letter spacing adds a step between each pair of characters.
  // Example: ink 600 wide and 60 tall against a reference 12:1 wants
  // 720, so 11 gaps at 64px take 120/704 ≈ 0.17em.
  const gaps = [...line].length - 1;
  const aspect = ref.box.w / ref.box.h;
  const wanted = gaps > 0 && probe.tracks ? (aspect * flat.box.h - flat.box.w) / (gaps * PROBE_PX) : 0;
  const tracking = Math.max(LETTER_SPACING_MIN, Math.min(LETTER_SPACING_MAX, wanted));
  const set = Math.abs(tracking) > 0.005 ? (probe.set(css, line, tracking) ?? flat) : flat;

  const grid = gridOf(set.ink, set.w, set.box, ref.cols);
  const own = set.box.w / set.box.h;
  const widthAgree = Math.min(own, aspect) / Math.max(own, aspect);
  return { score: softIou(ref.grid, soften(grid, ref.cols)) * widthAgree, tracking: set === flat ? 0 : tracking, inkPerPx: flat.box.h / PROBE_PX };
}

/** "1 line", "2 lines". */
const lines_ = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

/** The canvas candidates are set on, grown to the widest line asked for and
 * released when the ranking ends. */
class Probe {
  private canvas: RasterSurface | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  /** Whether this surface spaces letters; without it every face sets at 0. */
  tracks = false;

  set(css: string, line: string, tracking: number): (InkMask & { box: InkBox }) | null {
    const w = Math.ceil(PROBE_PX * ([...line].length * (1.4 + Math.max(0, tracking)) + 2));
    const h = PROBE_PX * 2;
    if (!this.canvas || this.canvas.width < w) {
      this.canvas = createRasterCanvas(w, h);
      this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D | null;
      this.tracks = Boolean(this.ctx && "letterSpacing" in this.ctx);
    }
    const ctx = this.ctx;
    if (!ctx) throw new Error("No 2D context to set type on.");
    const cw = this.canvas.width;
    ctx.clearRect(0, 0, cw, h);
    ctx.font = css;
    if (this.tracks) ctx.letterSpacing = `${tracking * PROBE_PX}px`;
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(line, PROBE_PX / 2, h / 2);

    const data = ctx.getImageData(0, 0, cw, h).data;
    const ink = new Uint8Array(cw * h);
    for (let i = 0; i < ink.length; i++) ink[i] = data[i * 4 + 3] > 127 ? 1 : 0;
    const box = inkBoxOf(ink, cw, h, { x: 0, y: 0, w: cw, h });
    return box ? { w: cw, h, ink, box } : null;
  }

  close(): void {
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.canvas = null;
    this.ctx = null;
  }
}

/** The median colour of a crop's outermost pixels. */
function borderMedian(data: Uint8ClampedArray, w: number, h: number): [number, number, number] {
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const take = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    r.push(data[i]);
    g.push(data[i + 1]);
    b.push(data[i + 2]);
  };
  for (let x = 0; x < w; x++) {
    take(x, 0);
    take(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    take(0, y);
    take(w - 1, y);
  }
  const mid = (v: number[]) => v.sort((p, q) => p - q)[v.length >> 1];
  return [mid(r), mid(g), mid(b)];
}

/** The threshold that best splits a 256-bin histogram in two (Otsu). */
function otsu(hist: Float64Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let cut = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      cut = t;
    }
  }
  return cut;
}

/** The box the ink inside `within` fills, specks left out. */
function inkBoxOf(ink: Uint8Array, w: number, h: number, within: InkBox): InkBox | null {
  const rows = new Float64Array(within.h);
  const cols = new Float64Array(within.w);
  for (let y = 0; y < within.h; y++) {
    const off = (within.y + y) * w + within.x;
    for (let x = 0; x < within.w; x++) {
      if (ink[off + x]) {
        rows[y]++;
        cols[x]++;
      }
    }
  }
  const span = (v: Float64Array) => {
    const floor = Math.max(1, Math.max(...v) * SPECK);
    let a = 0;
    while (a < v.length && v[a] < floor) a++;
    let b = v.length - 1;
    while (b > a && v[b] < floor) b--;
    return a < v.length ? [a, b] : null;
  };
  const ys = span(rows);
  const xs = span(cols);
  if (!ys || !xs) return null;
  return { x: within.x + xs[0], y: within.y + ys[0], w: xs[1] - xs[0] + 1, h: ys[1] - ys[0] + 1 };
}

/** The rows of ink inside a box, split where a run of empty rows parts them. */
function bandsOf(ref: InkMask, box: InkBox): InkBox[] {
  const rows: number[] = [];
  for (let y = 0; y < box.h; y++) {
    let n = 0;
    const off = (box.y + y) * ref.w + box.x;
    for (let x = 0; x < box.w; x++) n += ref.ink[off + x];
    rows.push(n);
  }
  const floor = Math.max(1, Math.max(...rows) * SPECK);
  const bands: InkBox[] = [];
  let start = -1;
  for (let y = 0; y <= rows.length; y++) {
    const on = y < rows.length && rows[y] >= floor;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      const band = inkBoxOf(ref.ink, ref.w, ref.h, { x: box.x, y: box.y + start, w: box.w, h: y - start });
      if (band) bands.push(band);
      start = -1;
    }
  }
  // A sliver of a band is a descender or an accent that broke loose.
  const tallest = Math.max(...bands.map((b) => b.h));
  return bands.filter((b) => b.h >= tallest * 0.25);
}

/** Grid columns for a box: its shape at GRID_ROWS rows. */
const gridCols = (b: InkBox) => Math.max(4, Math.min(640, Math.round((GRID_ROWS * b.w) / b.h)));

/** A box of ink averaged onto a GRID_ROWS × cols grid, each cell the share
 * of ink in the stretch of the box it covers. */
function gridOf(ink: Uint8Array, w: number, box: InkBox, cols: number): Float32Array {
  const grid = new Float32Array(GRID_ROWS * cols);
  const edge = (i: number, n: number, of: number) => Math.floor((i * of) / n);
  for (let gy = 0; gy < GRID_ROWS; gy++) {
    const y0 = edge(gy, GRID_ROWS, box.h);
    const y1 = Math.max(y0 + 1, edge(gy + 1, GRID_ROWS, box.h));
    for (let gx = 0; gx < cols; gx++) {
      const x0 = edge(gx, cols, box.w);
      const x1 = Math.max(x0 + 1, edge(gx + 1, cols, box.w));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const off = (box.y + y) * w + box.x;
        for (let x = x0; x < x1; x++) sum += ink[off + x];
      }
      grid[gy * cols + gx] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return grid;
}

/** A grid with each cell averaged with its neighbours, so ink a cell off
 * still overlaps. */
function soften(grid: Float32Array, cols: number): Float32Array {
  const out = new Float32Array(grid.length);
  for (let y = 0; y < GRID_ROWS; y++) {
    for (let x = 0; x < cols; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= GRID_ROWS || xx < 0 || xx >= cols) continue;
          sum += grid[yy * cols + xx];
          n++;
        }
      }
      out[y * cols + x] = sum / n;
    }
  }
  return out;
}

/** Overlap of two soft masks: Σmin / Σmax. */
function softIou(a: Float32Array, b: Float32Array): number {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < a.length; i++) {
    lo += Math.min(a[i], b[i]);
    hi += Math.max(a[i], b[i]);
  }
  return hi > 0 ? lo / hi : 0;
}
