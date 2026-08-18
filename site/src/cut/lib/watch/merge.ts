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

/** How much of [0, duration] no watch has covered, in seconds. Coverage is
 * the union of watched spans, so a look aimed at the middle of a source
 * leaves the head uncovered and says so — what `coveredTo` alone cannot. */
export function uncoveredSeconds(
  watch: { ranges: { from: number; to: number }[] } | undefined,
  duration: number
): number {
  let covered = 0;
  let cursor = 0;
  for (const rg of watch?.ranges ?? []) {
    const from = Math.max(rg.from, cursor);
    if (rg.to > from) {
      covered += rg.to - from;
      cursor = rg.to;
    }
  }
  return Math.max(0, round2(duration - covered));
}

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
  // Notes survive a re-watch: they are what someone read off the source, not
  // a product of this pass.
  return { ranges, frames, sceneChanges, ...(prev?.notes?.length ? { notes: prev.notes } : {}) };
}

/** Fold written observations into an asset's watch record. A new note owns
 * its span: stored notes that fall inside it drop, so re-reading a stretch
 * closely supersedes the coarse pass that first described it. Everything
 * else stays, sorted by time. */
export function mergeWatchNotes(
  prev: AssetWatch | undefined,
  add: { from: number; to: number; text: string }[]
): AssetWatch {
  const incoming = add
    .map((n) => ({
      from: round2(Math.max(0, Math.min(n.from, n.to))),
      to: round2(Math.max(n.from, n.to)),
      text: n.text.trim(),
    }))
    .filter((n) => n.text.length > 0);
  // The incoming spans, unioned: a stored note goes when the new reading
  // covers the ground it described, whether by one note or several.
  const union: { from: number; to: number }[] = [];
  for (const n of [...incoming].sort((a, b) => a.from - b.from)) {
    const last = union[union.length - 1];
    if (last && n.from <= last.to + EPS) last.to = Math.max(last.to, n.to);
    else union.push({ from: n.from, to: n.to });
  }
  const covered = (n: { from: number; to: number }) =>
    union.some((x) => n.from >= x.from - EPS && n.to <= x.to + EPS);
  const notes = (prev?.notes ?? [])
    .filter((n) => !covered(n))
    .concat(incoming)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  return {
    ranges: prev?.ranges ?? [],
    frames: prev?.frames ?? [],
    sceneChanges: prev?.sceneChanges ?? [],
    ...(notes.length ? { notes } : {}),
  };
}

/** The stretches of [0, duration] no note describes yet, ascending — what is
 * left to look at and write down. Slivers under MIN_GAP_S are ignored, the
 * same way coverage gaps are. */
export function unnotedSpans(
  watch: AssetWatch | undefined,
  duration: number
): { from: number; to: number }[] {
  const gaps: { from: number; to: number }[] = [];
  let cursor = 0;
  for (const n of [...(watch?.notes ?? [])].sort((a, b) => a.from - b.from)) {
    if (n.from - cursor >= MIN_GAP_S) gaps.push({ from: round2(cursor), to: round2(n.from) });
    cursor = Math.max(cursor, n.to);
  }
  if (duration - cursor >= MIN_GAP_S) gaps.push({ from: round2(cursor), to: round2(duration) });
  return gaps;
}
