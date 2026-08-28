/**
 * Background removal: the per-clip cutout model every renderer shares.
 *
 * A removal turns a clip's picture into a keyed layer: an AI matte baked to a
 * grayscale video the clip references decides what stays, a stroke draws ink
 * around the silhouette, and a backdrop fills in behind it. The model lives
 * here so the doc, the panels, the chat tools, and all three renderers read
 * one shape.
 */

export type RemovalMode = "auto" | "custom";

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
export const STROKE_FEATHER_MAX = 40;

export interface RemovalStroke {
  style: StrokeStyleId;
  /** Ink color, "#rrggbb". */
  color: string;
  /** Ink thickness, design px; absent = STROKE_DEFAULT_WIDTH. */
  width?: number;
  /** Edge softness: the finished ink blurred by this many design px;
   * absent = crisp. */
  feather?: number;
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
  /** The cutout is switched off: nothing renders and no bake runs, but the
   * baked matte and every setting stay on the clip, so switching back on is
   * instant and re-bills nothing. */
  off?: boolean;
  /** The direction. Absent, the selection stays and the picture around it is
   * removed; true, the selection itself is removed and the rest stays. The
   * selection is the same either way — the mode only picks how it is found —
   * so a baked matte serves both directions and flipping re-bakes nothing. */
  invert?: boolean;
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
  /** The bake was explicitly started — the panel's Apply button or the chat
   * tool. Nothing bakes until this is set: a mode pick, strokes, and words
   * only describe the selection, so no work runs (and no credits are spent)
   * on their own. */
  requested?: boolean;
  /** The hosted quality pass was asked for — the panel's Apply button once
   * the free matte stands, or the chat tool. Auto mode's paid refine runs
   * only once this is set; custom bakes are the hosted tracker's from the
   * start. */
  refine?: boolean;
  stroke?: RemovalStroke;
  backdrop?: RemovalBackdrop;
}

/** Whether the removal changes the picture at all. */
export function removalActive(r?: ClipRemoval): boolean {
  return !!r && !r.off;
}

/** A removal whose owed bake has no matte yet: a bake is owed once Apply
 * (or the chat tool) requests it, and a switched-off cutout owes nothing. */
export function removalNeedsBake(r?: ClipRemoval): boolean {
  if (!r || r.off || r.matte) return false;
  return !!r.requested;
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
