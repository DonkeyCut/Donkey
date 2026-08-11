import type { AssetSpeech, AssetWatch, WatchKeepReason } from "../types";

/** Spans closer than this merge into one (matches the 2-dp times stored). */
const EPS = 0.011;

/** Uncovered slivers shorter than this are left alone — a frame there would
 * duplicate its neighbors. */
const MIN_GAP_S = 2;

/** The first stretch of [0, duration] a coverage record leaves uncovered,
 * capped at `cap` seconds. Null once coverage is effectively complete.
 * Works for any record carrying merged ranges (watch and speech alike). */
export function nextUncoveredSpan(
  watch: { ranges: { from: number; to: number }[] } | undefined,
  duration: number,
  cap = 600
): { from: number; to: number } | null {
  let cursor = 0;
  for (const rg of watch?.ranges ?? []) {
    if (rg.from - cursor >= MIN_GAP_S)
      return { from: cursor, to: Math.min(rg.from, cursor + cap) };
    cursor = Math.max(cursor, rg.to);
  }
  if (duration - cursor < MIN_GAP_S) return null;
  return { from: cursor, to: Math.min(duration, cursor + cap) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Fold a new watch result into an asset's stored watch metadata. The new
 * span is authoritative for what it covered: stored frames and cuts inside
 * [from, to] are replaced by the new ones, spans union, and everything stays
 * sorted. Watching again over the same stretch refreshes it; watching a new
 * stretch extends it. */
/** Fold a transcribed chunk into an asset's stored transcript, the same way
 * mergeWatch folds frames: the chunk is authoritative for its span, spans
 * union, segments stay sorted by start. `noSpeech` settles only when the
 * whole source is covered and nothing was heard. */
export function mergeSpeech(
  prev: AssetSpeech | undefined,
  add: {
    from: number;
    to: number;
    segments: { start: number; end: number; text: string }[];
    locale?: string;
  },
  duration: number
): AssetSpeech {
  const from = round2(Math.min(add.from, add.to));
  const to = round2(Math.max(add.from, add.to));
  const inside = (t: number) => t >= from - EPS && t <= to + EPS;

  const segments = (prev?.segments ?? [])
    .filter((sg) => !inside(sg.start))
    .concat(
      add.segments
        .filter((sg) => sg.text.trim().length > 0)
        .map((sg) => ({ start: round2(sg.start), end: round2(sg.end), text: sg.text.trim() }))
    )
    .sort((a, b) => a.start - b.start);

  const ranges: AssetSpeech["ranges"] = [];
  for (const rg of [...(prev?.ranges ?? []), { from, to }].sort((a, b) => a.from - b.from)) {
    const last = ranges[ranges.length - 1];
    if (last && rg.from <= last.to + EPS) last.to = Math.max(last.to, rg.to);
    else ranges.push({ from: rg.from, to: rg.to });
  }
  const covered = nextUncoveredSpan({ ranges }, duration) === null;
  return {
    ranges,
    segments,
    ...(covered && segments.length === 0 ? { noSpeech: true as const } : {}),
    ...(add.locale ?? prev?.locale ? { locale: add.locale ?? prev?.locale } : {}),
  };
}

export function mergeWatch(
  prev: AssetWatch | undefined,
  add: {
    from: number;
    to: number;
    frames: { t: number; via: WatchKeepReason }[];
    sceneChanges: number[];
  }
): AssetWatch {
  const from = round2(Math.min(add.from, add.to));
  const to = round2(Math.max(add.from, add.to));
  const inside = (t: number) => t >= from - EPS && t <= to + EPS;

  const frames = (prev?.frames ?? [])
    .filter((f) => !inside(f.t))
    .concat(add.frames.map((f) => ({ t: round2(f.t), via: f.via })))
    .sort((a, b) => a.t - b.t);
  const sceneChanges = (prev?.sceneChanges ?? [])
    .filter((t) => !inside(t))
    .concat(add.sceneChanges.map(round2))
    .sort((a, b) => a - b);

  const ranges: AssetWatch["ranges"] = [];
  for (const rg of [...(prev?.ranges ?? []), { from, to }].sort((a, b) => a.from - b.from)) {
    const last = ranges[ranges.length - 1];
    if (last && rg.from <= last.to + EPS) last.to = Math.max(last.to, rg.to);
    else ranges.push({ from: rg.from, to: rg.to });
  }
  return { ranges, frames, sceneChanges };
}
