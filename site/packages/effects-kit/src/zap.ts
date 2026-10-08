/**
 * Electric arcs crawling over an element: the zap hit.
 *
 * The arcs are pixels, so one painter draws them for every renderer — the
 * export's baked frames and the preview's arc canvas alike. Each arc is a
 * jagged bolt between two points of the element's box, re-dealt `ZAP_FPS`
 * times a second from a seed, so the same moment always crackles the same
 * way. A bolt is a wide blue glow under a thin white core, with a flare where
 * it lands.
 */

/** How often the arcs re-deal, a second. */
export const ZAP_FPS = 12;

/** The arcs at one moment: how strong (0..1) and which deal. */
export interface ZapPhase {
  amount: number;
  seed: number;
}

/** The deal a zap shows at `tLocal` seconds into its element. */
export const zapSeed = (tLocal: number) => Math.floor(Math.max(0, tLocal) * ZAP_FPS);

/** The bloom, glow and core colors of a bolt. */
const BLOOM = "rgba(120,160,255,0.22)";
const GLOW = "rgba(140,175,255,0.8)";
const HALO = "rgba(90,140,255,0.95)";
const CORE = "rgba(240,246,255,1)";

/** A small seeded generator, so a deal is the same in every renderer. */
function dealer(seed: number): () => number {
  let s = (Math.imul(seed + 1, 2654435761) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x6d2b79f5) >>> 0;
    // XOR yields a signed int; `>>> 0` keeps the draw in 0..1.
    s = (s ^ (s >>> 13)) >>> 0;
    return s / 4294967296;
  };
}

/** A bolt from a to b: the line split in halves, each midpoint knocked
 * sideways by a share of its span that shrinks as the halves do. */
function bolt(ax: number, ay: number, bx: number, by: number, rand: () => number): [number, number][] {
  let pts: [number, number][] = [[ax, ay], [bx, by]];
  let jag = 0.24;
  for (let level = 0; level < 6; level++) {
    const next: [number, number][] = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const off = (rand() - 0.5) * 2 * jag * len;
      // Sideways is the span's normal.
      const nx = len ? -(y1 - y0) / len : 0;
      const ny = len ? (x1 - x0) / len : 0;
      next.push([(x0 + x1) / 2 + nx * off, (y0 + y1) / 2 + ny * off], pts[i + 1]);
    }
    pts = next;
    jag *= 0.72;
  }
  return pts;
}

/**
 * Draw the arcs over a box (`cx, cy, w, h` in the current transform). `scale`
 * is output px per design px. The bolts stay inside the box's own height
 * band and a little past its ends, so a crop padded for the element holds
 * them.
 */
export function paintZap(
  ctx: CanvasRenderingContext2D,
  box: { cx: number; cy: number; w: number; h: number },
  zap: ZapPhase,
  scale: number
): void {
  const k = Math.min(1, Math.max(0, zap.amount));
  if (k <= 0) {
    return;
  }
  const rand = dealer(zap.seed);
  const count = 2 + Math.round(3 * k);
  const pick = () => [box.cx + (rand() - 0.5) * box.w * 1.05, box.cy + (rand() - 0.5) * box.h * 0.9] as const;

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (let i = 0; i < count; i++) {
    // Each bolt reaches a sixth to a half of the box across.
    const [ax, ay] = pick();
    const reach = box.w * (0.16 + 0.34 * rand());
    const turn = rand() * Math.PI * 2;
    const bx = Math.min(box.cx + box.w * 0.55, Math.max(box.cx - box.w * 0.55, ax + Math.cos(turn) * reach));
    const by = Math.min(box.cy + box.h * 0.45, Math.max(box.cy - box.h * 0.45, ay + Math.sin(turn) * reach * 0.5));
    const pts = bolt(ax, ay, bx, by, rand);
    const trace = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let j = 1; j < pts.length; j++) {
        ctx.lineTo(pts[j][0], pts[j][1]);
      }
    };

    // A wide bloom, the blue glow, then the white-hot core over it.
    ctx.globalAlpha = k;
    ctx.shadowColor = HALO;
    ctx.shadowBlur = 30 * scale;
    ctx.strokeStyle = BLOOM;
    ctx.lineWidth = 16 * scale;
    trace();
    ctx.stroke();
    ctx.shadowBlur = 12 * scale;
    ctx.strokeStyle = GLOW;
    ctx.lineWidth = 6 * scale;
    trace();
    ctx.stroke();
    ctx.shadowColor = CORE;
    ctx.shadowBlur = 4 * scale;
    ctx.strokeStyle = CORE;
    ctx.lineWidth = 2.5 * scale;
    trace();
    ctx.stroke();

    // A flare where the bolt lands.
    const r = (16 + 22 * rand()) * scale * k;
    const flare = ctx.createRadialGradient(bx, by, 0, bx, by, r);
    flare.addColorStop(0, "rgba(255,255,255,1)");
    flare.addColorStop(0.35, "rgba(150,185,255,0.8)");
    flare.addColorStop(1, "rgba(90,140,255,0)");
    ctx.shadowColor = "transparent";
    ctx.fillStyle = flare;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
