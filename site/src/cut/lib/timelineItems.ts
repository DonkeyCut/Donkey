import { groupRemap } from "@donkeycut/effects-kit";
import { ITEM_KINDS, type ItemKind, type ItemKindDef, type ItemLists, type ItemOf, type TimelineClipboardItem } from "./itemKinds";
import type { Selection } from "./types";

export const itemKey = (sel: NonNullable<Selection>) => `${sel.kind}:${sel.id}`;
const definition = (kind: ItemKind) => ITEM_KINDS[kind] as ItemKindDef<ItemKind>;

/** Every basic timeline operation reads the same item registry. */
export function timelineItem(s: ItemLists, sel: NonNullable<Selection>) {
  return definition(sel.kind).list(s).find((item) => item.id === sel.id);
}

export function timelineFootprint(cb: TimelineClipboardItem) {
  const def = definition(cb.kind);
  return {
    key: `${cb.kind}:${cb.item.id}`, row: `${cb.kind}:${def.lane(cb.item)}`,
    start: cb.item.start, end: cb.item.start + def.duration(cb.item),
  };
}

export function timelineCopies(s: ItemLists, selection: readonly Selection[]): TimelineClipboardItem[] {
  return selection.flatMap((sel) => {
    const item = sel && timelineItem(s, sel);
    return sel && item ? [{ kind: sel.kind, item: definition(sel.kind).clone(item) } as TimelineClipboardItem] : [];
  });
}

export function timelineRange(s: ItemLists, selection: readonly Selection[]) {
  let start = Infinity;
  let end = -Infinity;
  for (const sel of selection) {
    const item = sel && timelineItem(s, sel);
    if (!sel || !item) continue;
    start = Math.min(start, item.start);
    end = Math.max(end, item.start + definition(sel.kind).duration(item));
  }
  return Number.isFinite(start) && end > start ? { start, end } : null;
}

export function mapTimelineItems(s: ItemLists, selection: readonly Selection[], map: (item: TimelineClipboardItem) => TimelineClipboardItem | null): ItemLists {
  const keys = new Set(selection.flatMap((sel) => sel ? [itemKey(sel)] : []));
  let next = s;
  for (const kind of new Set(selection.flatMap((sel) => sel ? [sel.kind] : []))) {
    const def = definition(kind);
    const list = def.list(next);
    let changed = false;
    const mapped = list.flatMap((item) => {
      if (!keys.has(`${kind}:${item.id}`)) return [item];
      const result = map({ kind, item } as TimelineClipboardItem);
      changed ||= result?.item !== item;
      return result ? [result.item] : [];
    });
    if (changed) next = def.withList(next, mapped);
  }
  return next;
}

/** Find one free landing for the selection, preserving all relative timing. */
export function timelinePlacementDelta(s: ItemLists, items: TimelineClipboardItem[], wanted: number, moving = false): number {
  if (!items.length) return 0;
  const blocks = items.map(timelineFootprint);
  const keys = new Set(blocks.map((b) => b.key));
  const rows = new Set(blocks.map((b) => b.row));
  const rest = new Map<string, ReturnType<typeof timelineFootprint>[]>();
  let blockers = 0;
  for (const kind of new Set(items.map((cb) => cb.kind))) {
    const def = definition(kind);
    for (const item of def.list(s)) {
      const row = `${kind}:${def.lane(item)}`;
      if (!rows.has(row) || (moving && keys.has(`${kind}:${item.id}`))) continue;
      const list = rest.get(row) ?? [];
      list.push(timelineFootprint({ kind, item } as TimelineClipboardItem));
      rest.set(row, list);
      blockers++;
    }
  }
  let delta = Math.max(wanted, -Math.min(...blocks.map((b) => b.start)));
  for (let pass = 0; pass <= blocks.length * blockers; pass++) {
    let next = delta;
    for (const b of blocks) for (const r of rest.get(b.row) ?? []) {
      if ( b.start + delta < r.end - 1e-6 && b.end + delta > r.start + 1e-6)
        next = Math.max(next, r.end - b.start);
    }
    if (next === delta) return delta;
    delta = next;
  }
  return delta;
}

export function shiftedTimelineItems(s: ItemLists, items: TimelineClipboardItem[], delta: number): ItemLists {
  return mapTimelineItems(s, items.map((cb) => ({ kind: cb.kind, id: cb.item.id })), (cb) => ({
    kind: cb.kind, item: definition(cb.kind).at(cb.item, cb.item.start + delta),
  } as TimelineClipboardItem));
}

/** Paste always adds copies. Every type keeps its properties, duration and offsets. */
export function pasteTimelineItems(s: ItemLists, items: TimelineClipboardItem[], at: number, newId: () => string) {
  if (!items.length) return { next: s, selection: [] as NonNullable<Selection>[] };
  const delta = timelinePlacementDelta(s, items, at - Math.min(...items.map((cb) => cb.item.start)));
  const regroup = groupRemap(newId);
  const selection: NonNullable<Selection>[] = [];
  const added = new Map<ItemKind, ItemOf[ItemKind][]>();
  for (const cb of items) {
    const def = definition(cb.kind);
    const copy = { ...def.at(def.clone(cb.item), cb.item.start + delta), ...regroup(cb.item), id: newId() };
    const list = added.get(cb.kind) ?? [];
    list.push(copy);
    added.set(cb.kind, list);
    selection.push({ kind: cb.kind, id: copy.id });
  }
  let next = s;
  for (const [kind, copies] of added) {
    const def = definition(kind);
    next = def.withList(next, [...def.list(next), ...copies].sort((a, b) => a.start - b.start));
  }
  return { next, selection };
}

/** Split selected items that cover the cut, in one document edit. */
export function splitTimelineItems(s: ItemLists, selection: readonly Selection[], at: number, newId: () => string) {
  const keys = new Set(selection.flatMap((sel) => sel ? [itemKey(sel)] : []));
  const selected: NonNullable<Selection>[] = [];
  let next = s;
  for (const kind of new Set(selection.flatMap((sel) => sel ? [sel.kind] : []))) {
    const def = definition(kind);
    let changed = false;
    const split = def.split;
    if (!split) continue;
    const items = def.list(next).flatMap((item) => {
      if (!keys.has(`${kind}:${item.id}`) || at <= item.start + 0.05 || at >= item.start + def.duration(item) - 0.05) return [item];
      const [left, tail] = split(def.clone(item), at);
      const right = { ...tail, id: newId() };
      selected.push({ kind, id: right.id });
      changed = true;
      return [left, right];
    });
    if (changed) next = def.withList(next, items);
  }
  return { next, selection: selected };
}
