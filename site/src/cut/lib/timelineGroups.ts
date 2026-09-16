import { ITEM_KIND_IDS, ITEM_KINDS, type ItemLists } from "./itemKinds";
import { mapTimelineItems, shiftedTimelineItems, timelineCopies, timelineItem, timelinePlacementDelta } from "./timelineItems";
import type { Selection } from "./types";

export const TIMELINE_ITEM_KINDS = ITEM_KIND_IDS;
type ItemSelection = NonNullable<Selection>;

/** A group is an explicit set of timeline items. Selecting any member selects the set. */
export function expandTimelineGroups(s: ItemLists, selection: readonly Selection[]): ItemSelection[] {
  const selected = new Map<string, ItemSelection>();
  const groups = new Set<string>();
  for (const sel of selection) {
    if (!sel) continue;
    const item = timelineItem(s, sel);
    if (!item) continue;
    selected.set(`${sel.kind}:${sel.id}`, sel);
    if (item.groupId) groups.add(item.groupId);
  }
  if (groups.size) for (const kind of TIMELINE_ITEM_KINDS) {
    for (const item of ITEM_KINDS[kind].list(s)) {
      if (item.groupId && groups.has(item.groupId)) selected.set(`${kind}:${item.id}`, { kind, id: item.id });
    }
  }
  return [...selected.values()];
}

export function selectedGroupIds(s: ItemLists, selection: readonly Selection[]): Set<string> {
  return new Set(selection.flatMap((sel) => {
    const id = sel && timelineItem(s, sel)?.groupId;
    return id ? [id] : [];
  }));
}

/** Keep only selection ids, list references and a boolean per kind between store updates. */
export function createSelectedGroupSelector() {
  let selection: readonly Selection[] | undefined;
  const kinds = TIMELINE_ITEM_KINDS.map((kind) => ({
    kind, ids: new Set<string>(), list: null as readonly { id: string; groupId?: string }[] | null, grouped: false,
  }));
  return (s: ItemLists & { multiSelection: readonly Selection[] }): boolean => {
    if (selection !== s.multiSelection) {
      selection = s.multiSelection;
      for (const entry of kinds) {
        entry.ids.clear();
        entry.list = null;
        for (const sel of selection) if (sel?.kind === entry.kind) entry.ids.add(sel.id);
      }
    }
    let grouped = false;
    for (const entry of kinds) {
      const list = ITEM_KINDS[entry.kind].list(s);
      if (entry.list !== list) {
        entry.list = list;
        entry.grouped = entry.ids.size > 0 && list.some((item) => !!item.groupId && entry.ids.has(item.id));
      }
      grouped ||= entry.grouped;
    }
    return grouped;
  };
}

/** Open a slot in the base sequence; every moved or displaced group keeps its offsets. */
export function reorderTimelineClip(s: ItemLists, id: string, toIndex: number): ItemLists {
  if (!Number.isFinite(toIndex)) return s;
  const row = s.clips.filter((clip) => clip.track === 0).sort((a, b) => a.start - b.start);
  const from = row.findIndex((clip) => clip.id === id);
  const to = Math.max(0, Math.min(row.length - 1, Math.round(toIndex)));
  if (from < 0 || from === to) return s;
  const moved = row[from];
  const members = expandTimelineGroups(s, [{ kind: "clip", id }]);
  const clipIds = new Set(members.filter((sel) => sel.kind === "clip").map((sel) => sel.id));
  if (clipIds.has(row[to].id)) return s;
  const others = row.filter((clip) => !clipIds.has(clip.id));
  const index = others.findIndex((clip) => clip.id === row[to].id) + (to > from ? 1 : 0);
  const start = others[index]?.start ?? others.reduce((end, clip) => Math.max(end, clip.start + ITEM_KINDS.clip.duration(clip)), 0);
  const displaced = expandTimelineGroups(s, others.filter((clip) => clip.start >= start - 1e-6).map((clip) => ({ kind: "clip", id: clip.id })));
  const movingItems = timelineCopies(s, members);
  const displacedItems = timelineCopies(s, displaced);
  const fixed = mapTimelineItems(s, displaced, () => null);
  const delta = timelinePlacementDelta(fixed, movingItems, start - moved.start, true);
  let next = shiftedTimelineItems(s, movingItems, delta);
  const slot = Math.max(...row.filter((clip) => clipIds.has(clip.id)).map((clip) => clip.start + delta + ITEM_KINDS.clip.duration(clip))) - start;
  const shift = timelinePlacementDelta(next, displacedItems, slot, true);
  next = shiftedTimelineItems(next, displacedItems, shift);
  return next;
}

export function setTimelineGroup(s: ItemLists, selection: readonly Selection[], groupId: string | undefined): ItemLists {
  return mapTimelineItems(s, expandTimelineGroups(s, selection), (cb) => ({
    ...cb, item: { ...cb.item, groupId },
  } as typeof cb));
}
