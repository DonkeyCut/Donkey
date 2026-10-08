/**
 * Graffiti doodles: a shape that paints a hand-drawn mark and swaps it for a
 * new one on every beat — a dry-brush smear, a painted X, a burst, a tall
 * painted bar, a brushed ring, a pair of fat loops — often with a thin hand
 * line beside it in another ink. The paint is translucent, so the footage
 * shows through it the way sprayed and brushed paint lets it.
 *
 * The marks are pixels, so one painter draws them for every renderer: the
 * export's baked frames and the preview's doodle canvas alike. Each beat is
 * dealt from a seed, so the same moment always shows the same mark.
 */

/** How often a doodle deals a new mark, a second: every third frame at 30fps. */
export const DOODLE_FPS = 10;

/** The most extra inks a doodle takes beside its fill. */
export const DOODLE_INKS_MAX = 5;

/** A new doodle's paints: a teal fill with cream, red, orange and white
 * inks, the street-graffiti set. */
export const DOODLE_FILL = "#2FAFA2";
export const DOODLE_INKS = ["#F2E6C8", "#E0412F", "#F08A3C", "#FFFFFF"];

/** Keep the inks a call or a document holds that are colors, at most
 * `DOODLE_INKS_MAX` of them. */
export function cleanInks(inks: unknown): string[] {
  if (!Array.isArray(inks)) {
    return [];
  }
  return inks.filter((c): c is string => typeof c === "string" && c.trim().length > 0).slice(0, DOODLE_INKS_MAX);
}

/** The mark a doodle shows at `tLocal` seconds into its element. */
export const doodleBeat = (tLocal: number) => Math.floor(Math.max(0, tLocal) * DOODLE_FPS + 1e-6);

/** The brush marks a beat can deal. */
const MARKS = ["smear", "cross", "burst", "bar", "ring", "loops"] as const;
type Mark = (typeof MARKS)[number];

/** The thin hand lines that ride beside a mark. */
const LINES = ["oval", "strands", "squiggle"] as const;
type Line = (typeof LINES)[number];

/** How often a beat lays a thin line beside its mark. */
const LINE_ODDS = 0.45;

/** A thin line's width, px at 1080. */
const THIN = 7;

/** A bristle's paint strength, low to high: overlapping bristles build to
 * about two thirds cover, so the paint stays see-through and streaked. */
const BRISTLE_ALPHA = [0.22, 0.5] as const;

/** How a brush stroke's bristles end: `flat` all run its length, `round`
 * shorten toward its sides, so the stroke reads as a fat blob of paint. */
type Profile = "flat" | "round";

/** A small seeded generator, so a deal is the same in every renderer. */
function dealer(seed: number): () => number {
  let s = (Math.imul(seed + 1, 2654435761) ^ 0x85ebca6b) >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0;
    s = (s ^ (s >>> 13)) >>> 0;
    return s / 4294967296;
  };
}

/** A stable number for an element id, so two doodles deal apart. */
export function doodleSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** Where a doodle paints: its box's center and size, output px, and the
 * output px per design px. */
export interface DoodleBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  scale: number;
}

/**
 * A painter working in square units of the box's short side, centered on
 * the box: a tall box is `tall` units high, so marks keep their shape in any
 * box and the upright ones can run its whole height.
 */
interface Brush {
  ctx: CanvasRenderingContext2D;
  rand: () => number;
  box: DoodleBox;
  /** The box's short side, px. */
  unit: number;
  /** The mark's center and turn, units. */
  ox: number;
  oy: number;
  turn: number;
}

/** A unit point as output px, through the mark's turn. */
function px(b: Brush, u: number, v: number): [number, number] {
  const c = Math.cos(b.turn);
  const s = Math.sin(b.turn);
  const ru = u * c - v * s;
  const rv = u * s + v * c;
  return [b.box.cx + (b.ox + ru) * b.unit, b.box.cy + (b.oy + rv) * b.unit];
}

/** Lay one bristle from (x0, y0) to (x1, y1), bowed `bow` px off its line. */
function bristle(b: Brush, x0: number, y0: number, x1: number, y1: number, nx: number, ny: number, bow: number): void {
  const ctx = b.ctx;
  ctx.globalAlpha = BRISTLE_ALPHA[0] + (BRISTLE_ALPHA[1] - BRISTLE_ALPHA[0]) * b.rand();
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo((x0 + x1) / 2 + nx * bow, (y0 + y1) / 2 + ny * bow, x1, y1);
  ctx.stroke();
}

/** How many bristles a bundle `span` px wide holds, and their width. */
function bristles(b: Brush, span: number): { n: number; width: number } {
  const n = Math.max(10, Math.min(40, Math.round(span / (3 * b.box.scale))));
  return { n, width: (span / n) * 2.2 };
}

/**
 * A dry-brush stroke from a to z: a bundle of bristle lines side by side,
 * each starting and stopping a little apart and laid at its own strength,
 * so the paint reads streaked and broken at the ends. `width` is the
 * bundle's width in units.
 */
function brushStroke(b: Brush, a: [number, number], z: [number, number], width: number, profile: Profile = "flat"): void {
  const [ax, ay] = px(b, a[0], a[1]);
  const [zx, zy] = px(b, z[0], z[1]);
  const len = Math.hypot(zx - ax, zy - ay) || 1;
  const nx = -(zy - ay) / len;
  const ny = (zx - ax) / len;
  const span = width * b.unit;
  const { n, width: lw } = bristles(b, span);
  const ctx = b.ctx;
  ctx.lineCap = "round";
  ctx.lineWidth = lw;
  for (let i = 0; i < n; i++) {
    // Each bristle sits at its place across the bundle, bowed a little. A
    // round stroke's bristles cover the length an ellipse has there.
    const across = i / (n - 1) - 0.5;
    const off = across * span;
    const cut = profile === "round" ? (1 - Math.sqrt(Math.max(0, 1 - 4 * across * across))) / 2 : 0;
    const t0 = cut + b.rand() * 0.14;
    const t1 = 1 - cut - b.rand() * 0.14;
    const bow = (b.rand() - 0.5) * span * 0.35;
    bristle(
      b,
      ax + (zx - ax) * t0 + nx * off,
      ay + (zy - ay) * t0 + ny * off,
      ax + (zx - ax) * t1 + nx * off,
      ay + (zy - ay) * t1 + ny * off,
      nx,
      ny,
      bow
    );
  }
}

/** A brushed ring: the bundle swept round `sweep` radians of a circle of
 * radius `r` units about the mark's center, `width` units thick. */
function brushRing(b: Brush, r: number, width: number, sweep: number): void {
  const ctx = b.ctx;
  const [cx, cy] = px(b, 0, 0);
  const span = width * b.unit;
  const { n, width: lw } = bristles(b, span);
  const start = b.turn;
  ctx.lineCap = "round";
  ctx.lineWidth = lw;
  for (let i = 0; i < n; i++) {
    // Each bristle runs its own arc, a little short or long at both ends.
    const rad = r * b.unit + (i / (n - 1) - 0.5) * span;
    const a0 = start + b.rand() * 0.3;
    const a1 = start + sweep - b.rand() * 0.3;
    ctx.globalAlpha = BRISTLE_ALPHA[0] + (BRISTLE_ALPHA[1] - BRISTLE_ALPHA[0]) * b.rand();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, rad), a0, a1);
    ctx.stroke();
  }
}

/** A thin hand line through unit points, each knocked a little off. */
function thinLine(b: Brush, pts: [number, number][], width: number, closed: "open" | "closed"): void {
  const ctx = b.ctx;
  const wobble = 0.012;
  const out = pts.map(([u, v]) => px(b, u + (b.rand() - 0.5) * wobble, v + (b.rand() - 0.5) * wobble));
  ctx.globalAlpha = 0.9;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width * b.box.scale;
  ctx.beginPath();
  ctx.moveTo(out[0][0], out[0][1]);
  for (let i = 1; i < out.length; i++) {
    const [x, y] = out[i];
    const [px0, py0] = out[i - 1];
    ctx.quadraticCurveTo(px0, py0, (px0 + x) / 2, (py0 + y) / 2);
  }
  if (closed === "closed") {
    ctx.closePath();
  }
  ctx.stroke();
}

/** A ring of unit points around (u, v), radii ru × rv, its radius drifting
 * so it reads drawn by hand. */
function ringPoints(b: Brush, u: number, v: number, ru: number, rv: number, turns: number, steps: number): [number, number][] {
  const pts: [number, number][] = [];
  const start = b.rand() * Math.PI * 2;
  for (let i = 0; i <= steps; i++) {
    const a = start + (i / steps) * Math.PI * 2 * turns;
    const k = 1 + (b.rand() - 0.5) * 0.12;
    pts.push([u + Math.cos(a) * ru * k, v + Math.sin(a) * rv * k]);
  }
  return pts;
}

/** A mark's reach from its center, units: across and down when upright,
 * and whether it turns freely or stands upright. */
interface Reach {
  rx: number;
  ry: number;
  stance: "free" | "upright";
}

/** Place a mark of `reach` inside a box `wide` × `tall` units, at a random
 * spot and turn that keep it inside. A free mark may turn any way, so its
 * reach is a circle; an upright one leans only a little. */
function place(b: Brush, reach: Reach, wide: number, tall: number): void {
  const free = reach.stance === "free";
  const rx = free ? Math.hypot(reach.rx, reach.ry) : reach.rx + reach.ry * 0.1;
  const ry = free ? rx : reach.ry + reach.rx * 0.1;
  b.ox = (b.rand() * 2 - 1) * Math.max(0, wide / 2 - rx);
  b.oy = (b.rand() * 2 - 1) * Math.max(0, tall / 2 - ry);
  b.turn = free ? (b.rand() - 0.5) * Math.PI : (b.rand() - 0.5) * 0.2;
}

/** The share of a reach its strokes' own ends and bristle spill take, kept
 * free inside the box. */
const SPILL = 0.9;

/** Paint one brush mark of kind `mark`, `size` units across, in a box
 * `wide` × `tall` units. */
function paintMark(b: Brush, mark: Mark, size: number, wide: number, tall: number): void {
  const r = (size / 2) * SPILL;
  switch (mark) {
    case "smear": {
      // A fat smear, two passes laid slightly apart.
      place(b, { rx: r, ry: r * 0.45, stance: "free" }, wide, tall);
      brushStroke(b, [-r * 0.8, 0], [r * 0.8, -r * 0.15], 0.42 * size, "round");
      brushStroke(b, [-r * 0.65, r * 0.18], [r * 0.7, r * 0.05], 0.3 * size, "round");
      return;
    }
    case "cross": {
      place(b, { rx: r * 0.75, ry: r, stance: "free" }, wide, tall);
      brushStroke(b, [-r * 0.5, -r * 0.85], [r * 0.5, r * 0.85], 0.26 * size);
      brushStroke(b, [r * 0.5, -r * 0.85], [-r * 0.5, r * 0.85], 0.26 * size);
      return;
    }
    case "burst": {
      place(b, { rx: r, ry: r, stance: "free" }, wide, tall);
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI) / 3 + (b.rand() - 0.5) * 0.4;
        const k = r * (0.6 + 0.25 * b.rand());
        brushStroke(b, [-Math.cos(a) * k, -Math.sin(a) * k], [Math.cos(a) * k, Math.sin(a) * k], 0.22 * size);
      }
      return;
    }
    case "bar": {
      // A tall painted bar standing most of the box's height.
      const half = (tall / 2) * (0.75 + 0.2 * b.rand()) * SPILL;
      place(b, { rx: 0.1 * size, ry: half, stance: "upright" }, wide, tall);
      brushStroke(b, [0, -half], [b.rand() * 0.04, half], 0.16 * size);
      return;
    }
    case "ring": {
      // A fat brushed ring, left a little open.
      place(b, { rx: r, ry: r, stance: "free" }, wide, tall);
      brushRing(b, r * 0.72, 0.2 * size, Math.PI * (1.5 + 0.4 * b.rand()));
      return;
    }
    case "loops": {
      // Two fat loops side by side, each trailing a short tail.
      place(b, { rx: r, ry: r * 0.85, stance: "free" }, wide, tall);
      for (const u of [-r * 0.45, r * 0.45]) {
        thinLine(b, ringPoints(b, u, -r * 0.15, r * 0.3, r * 0.34, 1, 18), THIN * 3.5, "closed");
        thinLine(b, [[u + r * 0.28, -r * 0.15], [u + r * 0.3, r * 0.6]], THIN * 3.5, "open");
      }
      return;
    }
  }
}

/** Paint one thin hand line of kind `line` in a box `wide` × `tall` units. */
function paintLine(b: Brush, line: Line, wide: number, tall: number): void {
  switch (line) {
    case "oval": {
      // A tall looping oval, most of the box's height.
      const ry = (tall / 2) * (0.7 + 0.2 * b.rand()) * SPILL;
      const rx = Math.min(ry * 0.5, (wide / 2) * SPILL);
      place(b, { rx, ry, stance: "upright" }, wide, tall);
      thinLine(b, ringPoints(b, 0, 0, rx, ry, 1.1, 36), THIN, "open");
      return;
    }
    case "strands": {
      // Two or three thin strands standing the box's height, close together.
      const half = (tall / 2) * (0.8 + 0.15 * b.rand()) * SPILL;
      place(b, { rx: 0.06, ry: half, stance: "upright" }, wide, tall);
      const n = 2 + Math.floor(b.rand() * 2);
      for (let i = 0; i < n; i++) {
        const u = (i - (n - 1) / 2) * 0.05;
        thinLine(b, [[u, -half], [u + 0.01, 0], [u, half]], THIN * (1 - i * 0.2), "open");
      }
      return;
    }
    case "squiggle": {
      // A small spiral scribble.
      const r = 0.18 * SPILL;
      place(b, { rx: r, ry: r, stance: "free" }, wide, tall);
      const pts: [number, number][] = [];
      for (let i = 0; i <= 40; i++) {
        const q = i / 40;
        const a = q * Math.PI * 5;
        pts.push([Math.cos(a) * r * (0.15 + 0.85 * q), Math.sin(a) * r * (0.15 + 0.85 * q)]);
      }
      thinLine(b, pts, THIN * 1.5, "open");
      return;
    }
  }
}

/**
 * Paint what a doodle deals on `beat` into its box: a brush mark in one of
 * `inks`, and on some beats a thin hand line beside it in another. The box
 * is drawn in the current transform; nothing outside it is touched but the
 * soft spill of the strokes' round ends.
 */
export function paintDoodle(
  ctx: CanvasRenderingContext2D,
  box: DoodleBox,
  inks: readonly string[],
  beat: number,
  seed: number
): void {
  if (inks.length === 0) {
    return;
  }
  const rand = dealer((seed ^ Math.imul(beat + 1, 0x27d4eb2d)) >>> 0);
  const mark = MARKS[Math.floor(rand() * MARKS.length)];
  const inkAt = Math.floor(rand() * inks.length);

  // The box in square units of its short side, so a mark keeps its shape.
  const unit = Math.max(1, Math.min(box.w, box.h));
  const wide = box.w / unit;
  const tall = box.h / unit;
  const brush: Brush = { ctx, rand, box, unit, ox: 0, oy: 0, turn: 0 };
  ctx.save();
  ctx.strokeStyle = inks[inkAt];
  ctx.fillStyle = inks[inkAt];
  paintMark(brush, mark, 0.6 + rand() * 0.4, wide, tall);

  // Some beats add a thin line, in the next ink along when there is one.
  if (rand() < LINE_ODDS) {
    const line = LINES[Math.floor(rand() * LINES.length)];
    ctx.strokeStyle = inks[(inkAt + 1 + Math.floor(rand() * Math.max(1, inks.length - 1))) % inks.length];
    paintLine(brush, line, wide, tall);
  }
  ctx.restore();
}
