/**
 * Two motions that need the drawn picture to play: a dive, which flies the
 * view into a letter until its ink fills the frame, and a slot, which rolls
 * each character up a reel of other characters until it lands.
 *
 * The evaluator says how far each one stands. What a dive flies into comes
 * from the drawn picture — the point of the last letter that sits deepest in
 * its ink, and how deep — which `measureDiveFocus` (render.ts) finds once per
 * look. `diveView` folds the two into the scale and offset every renderer
 * draws under, and `slotReel` says what a rolling character shows.
 */

/** The point a dive flies into, in design px (1080 short side) from the
 * element's center, and the radius of ink around it. */
export interface DiveFocus {
  x: number;
  y: number;
  r: number;
}

/** A dive's view in the painter's own coordinates — the element unposed, in
 * output px: a point p draws at s·(p − f) + t. */
export interface DiveView {
  s: number;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
}

/** The deepest a dive zooms. A hairline face would otherwise ask for a scale
 * no renderer can draw. */
export const DIVE_MAX_SCALE = 600;

/** How far past the frame's corners the ink reaches when the dive lands, so
 * antialiased edges never show at the last frame. */
const DIVE_COVER = 1.05;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The view a dive draws under at `progress` (0 at rest, 1 landed).
 *
 * The focus travels from where the pose puts it to the frame's center while
 * the scale grows geometrically, so the flight reads at a constant speed and
 * lands with the ink disk around the focus reaching every corner. The view is
 * expressed in painter coordinates so it composes inside the pose: the posed
 * element draws P(V(p)), and P(V(f)) is the travelling focus.
 */
export function diveView(
  progress: number,
  focus: DiveFocus,
  pose: { x: number; y: number; dx: number; dy: number; scale: number; rotation: number },
  rest: { x: number; y: number },
  frame: { width: number; height: number; scale: number }
): DiveView {
  const { width: W, height: H, scale: k } = frame;
  const cx = rest.x * W;
  const cy = rest.y * H;
  const fx = cx + focus.x * k;
  const fy = cy + focus.y * k;
  const e = clamp01(progress);
  const sigma = pose.scale;
  if (e <= 0 || sigma <= 1e-6) return { s: 1, fx, fy, tx: fx, ty: fy };
  const ax = pose.x * W + pose.dx * k;
  const ay = pose.y * H + pose.dy * k;
  const th = (pose.rotation * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  // Where the pose puts the focus, and how wide its ink is on screen.
  const px = ax + sigma * (cos * (fx - cx) - sin * (fy - cy));
  const py = ay + sigma * (sin * (fx - cx) + cos * (fy - cy));
  const ink = Math.max(0.5, focus.r * k) * sigma;
  const reach = (Math.hypot(W, H) / 2) * DIVE_COVER;
  const most = Math.min(DIVE_MAX_SCALE, Math.max(1, reach / ink));
  const s = Math.pow(most, e);
  const Tx = px + (W / 2 - px) * e;
  const Ty = py + (H / 2 - py) * e;
  // Back through the pose: the painter-space point the pose sends to T.
  const ux = (Tx - ax) / sigma;
  const uy = (Ty - ay) / sigma;
  return {
    s,
    fx,
    fy,
    tx: cx + cos * ux + sin * uy,
    ty: cy - sin * ux + cos * uy,
  };
}

/** How far apart a reel's characters sit, in line heights. Tighter than a
 * line, so the band shows the letters above and below the one in the slot. */
export const SLOT_PITCH = 0.62;

/** A slot character's reel: what is in sight at `roll`, each at its vertical
 * offset in line heights (positive is below) and its own opacity. Letters roll
 * through letters of their own case and digits through digits; anything else
 * — a space, a mark — holds still. The fillers are a fixed draw per title and
 * position (`seed` is `slotSeed` of the title), so each title rolls through
 * its own characters and rolls the same way every time it plays. */
export function slotReel(
  ch: string,
  index: number,
  roll: number,
  seed: number
): { ch: string; y: number; alpha: number }[] {
  const pool = reelPool(ch);
  if (!pool || roll <= 0) return [{ ch, y: 0, alpha: 1 }];
  const lo = Math.floor(roll);
  const out: { ch: string; y: number; alpha: number }[] = [];
  for (let j = Math.max(0, lo - 1); j <= lo + 2; j++) {
    const y = (roll - j) * SLOT_PITCH;
    // Past the band's edge nothing of the character shows.
    if (Math.abs(y) >= 0.9) continue;
    out.push({ ch: j === 0 ? ch : filler(pool, ch, index, j, seed), y, alpha: 1 - Math.min(1, Math.abs(y)) * 0.7 });
  }
  return out;
}

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";

function reelPool(ch: string): string | null {
  if (DIGITS.includes(ch)) return DIGITS;
  if (ch.toLowerCase() === ch.toUpperCase()) return null;
  return ch === ch.toUpperCase() ? UPPER : LOWER;
}

/** A title's reel seed: its characters, with the line breaks wrapping puts in
 * left out, so every renderer seeds the same title the same way. */
export function slotSeed(text: string): number {
  let h = 2166136261;
  for (const ch of text.replace(/\s+/g, "")) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return h >>> 0;
}

function filler(pool: string, ch: string, index: number, step: number, seed: number): string {
  let h = (Math.imul(index + 1, 2654435761) ^ Math.imul(step, 40503) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  const pick = pool[((h ^ (h >>> 13)) >>> 0) % pool.length];
  return pick === ch ? pool[(pool.indexOf(pick) + 1) % pool.length] : pick;
}
