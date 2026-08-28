/**
 * Background removal: the per-clip cutout model and the reference math every
 * renderer shares.
 *
 * A removal turns a clip's picture into a keyed layer: an alpha matte decides
 * what stays (a chroma key computed live, or an AI matte baked to a grayscale
 * video the clip references), a stroke draws ink around the silhouette, and a
 * backdrop fills in behind it. The model lives here so the doc, the panels,
 * the chat tools, and all three renderers read one shape — and the chroma
 * math lives beside it so the GPU shader, the CPU pass, and the export's
 * matte videos resolve a key the same way to the pixel.
 */

export type RemovalMode = "auto" | "custom" | "chroma";

/** A chroma key: the picked backdrop color plus how it reaches. */
export interface ChromaKey {
  /** Picked key color, "#rrggbb". */
  color: string;
  /** Tolerance 0..1 — how far from the key a color still keys out. */
  intensity?: number;
  /** Edge rolloff 0..1 — how wide the soft band past the tolerance runs. */
  softness?: number;
  /** Spill suppression 0..1 — how hard key-colored fringe on the kept
   * pixels is pulled back toward neutral. */
  spill?: number;
}

export const CHROMA_DEFAULT_INTENSITY = 0.4;
export const CHROMA_DEFAULT_SOFTNESS = 0.25;
export const CHROMA_DEFAULT_SPILL = 0.5;

export const STROKE_STYLES = ["glow", "hand", "cut", "solid", "offset", "dotted"] as const;
export type StrokeStyleId = (typeof STROKE_STYLES)[number];

export const STROKE_STYLE_LABELS: Record<StrokeStyleId, string> = {
  glow: "Glow",
  hand: "Hand drawn",
  cut: "Straight cut",
  solid: "Solid",
  offset: "Offset",
  dotted: "Dotted",
};

/** Stroke lengths are design px at the 1080 short side, like masks. */
export const STROKE_DEFAULT_WIDTH = 12;
export const STROKE_WIDTH_MAX = 60;
export const STROKE_OFFSET_MAX = 120;

export interface RemovalStroke {
  style: StrokeStyleId;
  /** Ink color, "#rrggbb". */
  color: string;
  /** Ink thickness, design px; absent = STROKE_DEFAULT_WIDTH. */
  width?: number;
  /** Silhouette displacement for the "offset" style, design px per axis. */
  offsetX?: number;
  offsetY?: number;
}

export interface RemovalBackdrop {
  kind: "none" | "color" | "image";
  color?: string;
  /** Image fill: a project asset's id. */
  assetId?: string;
}

/** Custom-mode selection, persisted so a bake is reproducible and undoable. */
export interface RemovalSeeds {
  /** Source-time seconds → segmenter point prompts in frame fractions;
   * label 1 keeps, 0 removes. */
  prompts: { t: number; points: { x: number; y: number; label: 0 | 1 }[] }[];
  /** Raw brush paint per edited source second: small grayscale PNG data URLs,
   * white marks, `add` unions into the mask and `erase` subtracts. */
  paint?: { t: number; add?: string; erase?: string }[];
}

export interface ClipRemoval {
  mode: RemovalMode;
  /** The key, for mode "chroma". */
  chroma?: ChromaKey;
  /** Custom mode by description: what to keep, in a few words ("the dog").
   * The concept tracker mattes every match; painted seeds take over when the
   * user brushes instead. */
  subject?: string;
  /** The baked matte, for modes "auto" and "custom": a grayscale video asset
   * covering the clip's trimmed source range, white keeps the pixel. `in` is
   * the source second the matte's own zero maps to, so a later retrim keeps
   * reading the right frames; the fingerprint records what the matte was
   * baked from, so edits re-bake. */
  matte?: { assetId: string; fingerprint: string; quality: "local" | "hq"; in: number };
  /** Custom-mode selection. */
  seeds?: RemovalSeeds;
  /** The bake was explicitly started — the panel's Start/Apply button or the
   * chat tool. AI modes bake nothing until this is set, so picking a mode by
   * itself never spends compute. */
  requested?: boolean;
  stroke?: RemovalStroke;
  backdrop?: RemovalBackdrop;
}

/** Whether the removal changes the picture at all. */
export function removalActive(r?: ClipRemoval): boolean {
  if (!r) return false;
  if (r.mode === "chroma") return !!r.chroma?.color;
  return true;
}

/** An AI-mode removal whose started bake has no matte yet — still owed. */
export function removalNeedsBake(r?: ClipRemoval): boolean {
  return !!r && (r.mode === "auto" || r.mode === "custom") && !!r.requested && !r.matte;
}

/** What a baked matte was computed from: the source and the selection.
 * Trims stay out of it — a matte covering a wider source range than the clip
 * plays is still the right matte, so a retrim inside its coverage never
 * re-bakes (and never re-bills the quality pass). A mismatch means the
 * source or the seeds changed; the stale matte keeps drawing until the new
 * one lands. */
export function removalFingerprint(
  assetId: string,
  r: Pick<ClipRemoval, "mode" | "seeds" | "subject">
): string {
  const body = JSON.stringify([
    assetId,
    r.mode,
    r.mode === "custom" ? (r.seeds ?? null) : null,
    r.mode === "custom" ? (r.subject ?? null) : null,
  ]);
  // djb2 — short, stable, and identical everywhere the fingerprint is read.
  let hash = 5381;
  for (let i = 0; i < body.length; i++) hash = ((hash << 5) + hash + body.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// Chroma reference math. The WebGL shader mirrors these formulas with the
// same constants, so the GPU pass, this CPU pass, and the export mattes all
// key the same frame to the same alpha.

/** Chroma-plane distance that keys fully out at intensity 1. */
export const CHROMA_NEAR_MAX = 0.38;
/** Width of the soft band past the tolerance at softness 1. */
export const CHROMA_SOFT_MAX = 0.3;
/** How far past the soft band spill suppression keeps reaching. */
export const CHROMA_SPILL_REACH = 2;

export interface ChromaParams {
  /** Key chroma in BT.709 Cb/Cr, each -0.5..0.5. */
  keyCb: number;
  keyCr: number;
  /** Unit direction of the key's chroma, for the spill projection. */
  dirCb: number;
  dirCr: number;
  /** Distances in chroma-plane units: fully removed inside `near`, fully
   * kept past `far`. */
  near: number;
  far: number;
  spill: number;
}

function hexChannel(hex: string, i: number): number {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return Number.isFinite(v) ? v / 255 : 0;
}

/** BT.709 chroma of an r/g/b in 0..1. */
function chromaOf(r: number, g: number, b: number): { cb: number; cr: number } {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { cb: (b - y) / 1.8556, cr: (r - y) / 1.5748 };
}

/** Resolve a key's sliders into the numbers the passes run on. */
export function chromaParams(key: ChromaKey): ChromaParams {
  const r = hexChannel(key.color, 0);
  const g = hexChannel(key.color, 1);
  const b = hexChannel(key.color, 2);
  const { cb, cr } = chromaOf(r, g, b);
  const len = Math.hypot(cb, cr);
  const intensity = key.intensity ?? CHROMA_DEFAULT_INTENSITY;
  const softness = key.softness ?? CHROMA_DEFAULT_SOFTNESS;
  const near = Math.max(0.02, intensity * CHROMA_NEAR_MAX);
  return {
    keyCb: cb,
    keyCr: cr,
    dirCb: len > 0.001 ? cb / len : 0,
    dirCr: len > 0.001 ? cr / len : 1,
    near,
    far: near + Math.max(0.01, softness * CHROMA_SOFT_MAX),
    spill: key.spill ?? CHROMA_DEFAULT_SPILL,
  };
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** The alpha a pixel keeps under the key, 0..1, from its chroma distance. */
export function chromaAlphaOf(d: number, p: ChromaParams): number {
  const t = Math.min(1, Math.max(0, (d - p.near) / (p.far - p.near)));
  return smooth(t);
}

/**
 * Key an RGBA buffer in place: each pixel's alpha multiplies by how far its
 * chroma sits from the key, and kept pixels near the key lose their fringe —
 * the key's chroma direction is projected out of them, scaled by `spill` and
 * by how close they sit. This is the reference pass; the shader repeats it.
 */
/** The baked-matte contract every producer and reader shares: encoded matte
 * rate (coverage moves little in 1/15s, and every consumer's fps filter or
 * nearest-frame read duplicates up to the output rate), the frame's short
 * side (consumers scale it to the picture), and the encode rate. */
export const MATTE_FPS = 15;
export const MATTE_SHORT = 480;
export const MATTE_BITRATE = 1_000_000;
/** The longest span one hosted tracking part covers. Each uploaded segment
 * rides a fixed byte budget, so past a few minutes its bitrate — and the
 * tracker's masks with it — collapse; a longer clip's bake splits its span
 * into parts of at most this length and tracks each on its own budget. */
export const MATTE_MAX_S = 180;

/** Turn a decoded matte frame's luma into alpha coverage, in place: alpha
 * becomes the red channel's luma and the ink turns white, so the result
 * draws as coverage (`destination-in`) or as a lit silhouette alike. Matte
 * videos carry coverage as luma — H.264 has no alpha plane. */
export function matteLumaToAlpha(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    px[i + 3] = px[i];
    px[i] = 255;
    px[i + 1] = 255;
    px[i + 2] = 255;
  }
}

/** Flatten a tracker's mask frame to encodable gray, in place: coverage is
 * whatever the tracker painted over black — some render white, some tint per
 * object — so any lit channel reads as matte. */
export function coverageToGray(px: Uint8ClampedArray): void {
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.max(px[i], px[i + 1], px[i + 2]);
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
    px[i + 3] = 255;
  }
}

export function chromaAlphaInto(px: Uint8ClampedArray, key: ChromaKey): void {
  const p = chromaParams(key);
  const spillFar = p.near + (p.far - p.near) * CHROMA_SPILL_REACH;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255;
    const g = px[i + 1] / 255;
    const b = px[i + 2] / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const cb = (b - y) / 1.8556;
    const cr = (r - y) / 1.5748;
    const d = Math.hypot(cb - p.keyCb, cr - p.keyCr);
    const a = chromaAlphaOf(d, p);
    if (a < 1 || d < spillFar) {
      px[i + 3] = Math.round(px[i + 3] * a);
      if (a > 0 && p.spill > 0 && d < spillFar) {
        const proj = cb * p.dirCb + cr * p.dirCr;
        if (proj > 0) {
          const reach = 1 - Math.min(1, Math.max(0, (d - p.near) / (spillFar - p.near)));
          const cut = proj * p.spill * smooth(reach);
          const ncb = cb - p.dirCb * cut;
          const ncr = cr - p.dirCr * cut;
          const nr = y + 1.5748 * ncr;
          const nb = y + 1.8556 * ncb;
          const ng = (y - 0.2126 * nr - 0.0722 * nb) / 0.7152;
          px[i] = Math.max(0, Math.min(255, Math.round(nr * 255)));
          px[i + 1] = Math.max(0, Math.min(255, Math.round(ng * 255)));
          px[i + 2] = Math.max(0, Math.min(255, Math.round(nb * 255)));
        }
      }
    }
  }
}
