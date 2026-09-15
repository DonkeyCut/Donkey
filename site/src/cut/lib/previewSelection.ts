import { hasOverlayKeys, keyAt, upsertKey, type OverlayKey } from "@donkeycut/effects-kit";
import { clipLen, type EditorState } from "@/cut/lib/store";
import { clipKeyed, clipPoseAt, rectOf, type FrameRect } from "@/cut/lib/types";
import { captionStyle, laneHidden, trackPos } from "@/cut/lib/subtitles";

export const SELECTABLE_ITEM_KINDS = ["clip", "audio", "overlay", "cue"] as const;

type Position = {
  kind: "clip" | "overlay" | "cue";
  id: string;
  x: number;
  y: number;
  frame?: FrameRect;
  key?: OverlayKey;
  keys?: OverlayKey[];
  lane?: number;
};

/** Capture positions once per gesture. Every member receives the same delta. */
export function previewSelectionSnapshot(s: EditorState, t: number): Position[] {
  const selected = new Set((s.multiSelection.length ? s.multiSelection : [s.selection])
    .flatMap((item) => item ? [`${item.kind}:${item.id}`] : []));
  const positions: Position[] = [];
  for (const o of s.overlays) {
    if (!selected.has(`overlay:${o.id}`) || o.hidden || o.kind === "effect") continue;
    const key = hasOverlayKeys(o) ? keyAt(o, Math.max(0, Math.min(t - o.start, Math.max(0.1, o.end - o.start)))) : undefined;
    positions.push({ kind: "overlay", id: o.id, x: key?.x ?? o.x, y: key?.y ?? o.y, key, keys: o.kf });
  }
  for (const c of s.clips) {
    if (!selected.has(`clip:${c.id}`) || c.hidden) continue;
    const frame = rectOf(c);
    const local = Math.max(0, Math.min(t - c.start, clipLen(c)));
    const key = clipKeyed(c) ? { t: local, ...clipPoseAt(c, local) } : undefined;
    positions.push({ kind: "clip", id: c.id, x: key?.x ?? frame.x, y: key?.y ?? frame.y, frame, key, keys: c.kf });
  }
  const lanes = new Set<number>();
  for (const cue of s.subtitles.cues) {
    const lane = cue.lane ?? 0;
    if (!selected.has(`cue:${cue.id}`) || lanes.has(lane) || laneHidden(s.subtitles, lane)) continue;
    lanes.add(lane);
    const p = trackPos(s.subtitles, captionStyle(s.subtitles.style), lane);
    positions.push({ kind: "cue", id: cue.id, lane, x: p.x!, y: p.y! });
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
