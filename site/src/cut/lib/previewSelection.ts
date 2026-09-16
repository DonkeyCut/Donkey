import { hasOverlayKeys, keyAt, upsertKey, type OverlayKey } from "@donkeycut/effects-kit";
import { clipLen, type EditorState } from "@/cut/lib/store";
import { clampOverlayPos, clipKeyed, clipPoseAt, isShapeOverlay, isTextOverlay, rectOf, type FrameRect, type OverlayPatch, type Selection } from "@/cut/lib/types";
import { captionStyle, laneHidden, trackPos } from "@/cut/lib/subtitles";

export const SELECTABLE_ITEM_KINDS = ["clip", "audio", "overlay", "cue"] as const;

/** Two or more picture items selected: the selection frame carries the grips
 * and each member wears only its outline. */
export function pictureGroupSelected(multiSelection: readonly Selection[]): boolean {
  return multiSelection.filter((m) => m?.kind === "overlay" || m?.kind === "clip").length > 1;
}

type Position = {
  kind: "clip" | "overlay" | "cue";
  id: string;
  x: number;
  y: number;
  frame?: FrameRect;
  key?: OverlayKey;
  keys?: OverlayKey[];
  lane?: number;
  /** The item's angle at the gesture's start, degrees clockwise. */
  rotation: number;
  /** What a scale gesture grows: a shape or sticker's box, a title's size or
   * stretch, a clip's frame. A keyed item scales its key instead. */
  box?: { w: number; h?: number };
  text?: { size: number; stretchX: number; stretchY: number };
};

/** Into (-180, 180], the range every rotation is stored in. */
export const normDeg = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** Capture positions once per gesture. Every member receives the same delta. */
export function previewSelectionSnapshot(s: EditorState, t: number): Position[] {
  const selected = new Set((s.multiSelection.length ? s.multiSelection : [s.selection])
    .flatMap((item) => item ? [`${item.kind}:${item.id}`] : []));
  const positions: Position[] = [];
  for (const o of s.overlays) {
    if (!selected.has(`overlay:${o.id}`) || o.hidden || o.kind === "effect") continue;
    const key = hasOverlayKeys(o) ? keyAt(o, Math.max(0, Math.min(t - o.start, Math.max(0.1, o.end - o.start)))) : undefined;
    positions.push({
      kind: "overlay", id: o.id, x: key?.x ?? o.x, y: key?.y ?? o.y, key, keys: o.kf,
      rotation: key?.rotation ?? o.rotation ?? 0,
      box: isShapeOverlay(o) || o.kind === "sticker" ? { w: o.w, h: o.h } : undefined,
      text: isTextOverlay(o) ? { size: o.size, stretchX: o.stretchX ?? 1, stretchY: o.stretchY ?? 1 } : undefined,
    });
  }
  for (const c of s.clips) {
    if (!selected.has(`clip:${c.id}`) || c.hidden) continue;
    const frame = rectOf(c);
    const local = Math.max(0, Math.min(t - c.start, clipLen(c)));
    const key = clipKeyed(c) ? { t: local, ...clipPoseAt(c, local) } : undefined;
    positions.push({
      kind: "clip", id: c.id, x: key?.x ?? frame.x, y: key?.y ?? frame.y, frame, key, keys: c.kf,
      rotation: key?.rotation ?? c.rotation ?? 0,
    });
  }
  const lanes = new Set<number>();
  for (const cue of s.subtitles.cues) {
    const lane = cue.lane ?? 0;
    if (!selected.has(`cue:${cue.id}`) || lanes.has(lane) || laneHidden(s.subtitles, lane)) continue;
    lanes.add(lane);
    const p = trackPos(s.subtitles, captionStyle(s.subtitles.style), lane);
    positions.push({ kind: "cue", id: cue.id, lane, x: p.x!, y: p.y!, rotation: 0 });
  }
  return positions;
}

/** Deltas are frame fractions; clamp the group together to preserve spacing. */
export function movePreviewSelection(s: EditorState, positions: Position[], dx: number, dy: number) {
  let minX = -Infinity, maxX = Infinity, minY = -Infinity, maxY = Infinity;
  for (const p of positions) {
    const f = p.kind === "clip" && !p.key ? p.frame : undefined;
    minX = Math.max(minX, Math.min(0, (f ? 0.05 - f.w : 0.02) - p.x));
    maxX = Math.min(maxX, Math.max(0, (f ? 0.95 : 0.98) - p.x));
    minY = Math.max(minY, Math.min(0, (f ? 0.05 - f.h : 0.02) - p.y));
    maxY = Math.min(maxY, Math.max(0, (f ? 0.95 : 0.98) - p.y));
  }
  dx = Math.max(minX, Math.min(maxX, dx));
  dy = Math.max(minY, Math.min(maxY, dy));
  const patches: Parameters<EditorState["updateDocTransient"]>[0] = { clips: [], overlays: [] };
  for (const p of positions) {
    const x = p.x + dx, y = p.y + dy;
    const keyed = p.key ? { kf: upsertKey(p.keys, { ...p.key, x, y }) } : null;
    if (p.kind === "overlay") patches.overlays!.push({ id: p.id, patch: keyed ?? { x, y } });
    else if (p.kind === "clip") patches.clips!.push({ id: p.id, patch: keyed ?? { frame: { ...p.frame!, x, y } } });
    else s.setSubtitleTrackMeta(p.lane!, { x, y });
  }
  if (patches.clips!.length || patches.overlays!.length) s.updateDocTransient(patches);
}

type DocPatches = Parameters<EditorState["updateDocTransient"]>[0];

/** Land one pose on each member: a keyed item writes its key at the playhead,
 * the rest write their own fields. Clips place by their frame's top-left. */
function writePoses(
  s: EditorState,
  poses: { p: Position; x: number; y: number; rotation?: number; scale?: number; own?: OverlayPatch & Partial<FrameRect> }[],
) {
  const patches: DocPatches = { clips: [], overlays: [] };
  for (const { p, x, y, rotation, scale, own } of poses) {
    if (p.kind === "cue") {
      s.setSubtitleTrackMeta(p.lane!, { x, y });
      continue;
    }
    if (p.key) {
      const key = { ...p.key, x, y, ...(rotation !== undefined ? { rotation } : {}), ...(scale !== undefined ? { scale: p.key.scale * scale } : {}) };
      const patch = { kf: upsertKey(p.keys, key) };
      if (p.kind === "overlay") patches.overlays!.push({ id: p.id, patch });
      else patches.clips!.push({ id: p.id, patch });
      continue;
    }
    const turn = rotation === undefined ? {} : { rotation: rotation === 0 ? undefined : rotation };
    if (p.kind === "overlay") patches.overlays!.push({ id: p.id, patch: { x, y, ...turn, ...own } });
    else {
      const { w = p.frame!.w, h = p.frame!.h } = own ?? {};
      patches.clips!.push({ id: p.id, patch: { frame: { ...p.frame!, x, y, w, h }, ...turn } });
    }
  }
  if (patches.clips!.length || patches.overlays!.length) s.updateDocTransient(patches);
}

const clipCenter = (p: Position) => ({ x: p.x + (p.key ? 0 : p.frame!.w / 2), y: p.y + (p.key ? 0 : p.frame!.h / 2) });

/**
 * Scale the selection about an anchor (frame fractions) by kx and ky: every
 * center walks out from the anchor, and each item grows what it stores — a
 * shape's box, a sticker's width, a title's size (or its stretch on a
 * one-axis pull), a clip's frame, a keyed item's scale.
 */
export function scalePreviewSelection(s: EditorState, positions: Position[], anchor: { x: number; y: number }, kx: number, ky: number) {
  kx = Math.max(0.05, kx);
  ky = Math.max(0.05, ky);
  const uniform = Math.abs(kx - ky) < 1e-6;
  const k = uniform ? kx : kx * ky;
  writePoses(s, positions.map((p) => {
    const c = p.kind === "clip" ? clipCenter(p) : { x: p.x, y: p.y };
    const cx = anchor.x + (c.x - anchor.x) * kx;
    const cy = anchor.y + (c.y - anchor.y) * ky;
    if (p.key) return { p, x: cx, y: cy, scale: k };
    if (p.kind === "clip") {
      const w = p.frame!.w * kx, h = p.frame!.h * ky;
      return { p, x: Math.max(0.05 - w, Math.min(0.95, cx - w / 2)), y: Math.max(0.05 - h, Math.min(0.95, cy - h / 2)), own: { w, h } };
    }
    if (p.kind === "cue") return { p, x: cx, y: cy };
    let own: OverlayPatch | undefined;
    if (p.box) {
      // A sticker with no height of its own keeps its aspect and grows with
      // whichever axis the pull moved.
      own = { w: Math.max(0.01, p.box.w * (p.box.h === undefined && kx === 1 ? ky : kx)), ...(p.box.h !== undefined ? { h: Math.max(0.01, p.box.h * ky) } : {}) };
    } else if (p.text) {
      // Every frame writes the whole set from the snapshot, so a pull that
      // turns uniform mid-drag lands cleanly on one of the two.
      own = uniform
        ? { size: Math.max(8, p.text.size * k), stretchX: stretch(p.text.stretchX), stretchY: stretch(p.text.stretchY) }
        : { size: p.text.size, stretchX: stretch(p.text.stretchX * kx), stretchY: stretch(p.text.stretchY * ky) };
    }
    return { p, x: clampOverlayPos(cx), y: clampOverlayPos(cy), own };
  }));
}

const stretch = (v: number) => {
  const c = Math.max(0.25, Math.min(4, v));
  return Math.abs(c - 1) < 1e-6 ? undefined : c;
};

/**
 * Turn the selection rigidly about a center (frame fractions) by `delta`
 * degrees: every center orbits, in a square space keyed to width so the set
 * turns rigidly on screen, and every item adds the same angle to its own.
 */
export function rotatePreviewSelection(s: EditorState, positions: Position[], center: { x: number; y: number }, delta: number, aspect: number) {
  const rad = (delta * Math.PI) / 180;
  const ay = aspect;
  writePoses(s, positions.map((p) => {
    const c = p.kind === "clip" ? clipCenter(p) : { x: p.x, y: p.y };
    const ox = c.x - center.x;
    const oy = (c.y - center.y) * ay;
    const cx = center.x + ox * Math.cos(rad) - oy * Math.sin(rad);
    const cy = center.y + (ox * Math.sin(rad) + oy * Math.cos(rad)) / ay;
    const rotation = Math.round(normDeg(p.rotation + delta));
    if (p.kind === "cue") return { p, x: cx, y: cy };
    if (p.key) return { p, x: cx, y: cy, rotation };
    if (p.kind === "clip") return { p, x: cx - p.frame!.w / 2, y: cy - p.frame!.h / 2, rotation };
    return { p, x: clampOverlayPos(cx), y: clampOverlayPos(cy), rotation };
  }));
}
