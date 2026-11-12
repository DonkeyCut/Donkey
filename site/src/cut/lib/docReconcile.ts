// Merging a project document two writers changed at once: this tab, and
// whatever saved the stored copy since this tab last synced with it — another
// tab, the cloud worker running the agent's edits. Each side's changes land
// on the other's; where both changed the same value, this tab's stands,
// because that is the person looking at it.
import type { ProjectDoc } from "./types";

type Value = unknown;
type Keyed = { id: string } & Record<string, unknown>;

const isRecord = (v: Value): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Lists of items with ids merge item by item, e.g. clips, assets, cues. */
const isKeyedList = (v: Value): v is Keyed[] =>
  Array.isArray(v) && v.every((item) => isRecord(item) && typeof item.id === "string");

/** Deep equality that ignores key order and treats a missing key as null:
 * the stored copy comes back from the database with its keys reordered and
 * its empty fields dropped. */
function same(a: Value, b: Value): boolean {
  if (a === b || (a == null && b == null)) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) {
    return false;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!same(a[k], b[k])) {
      return false;
    }
  }
  return true;
}

/** One value both sides may have changed since `base`. */
function merge(base: Value, mine: Value, theirs: Value): Value {
  if (same(mine, base)) {
    return theirs;
  }
  if (same(theirs, base) || same(mine, theirs)) {
    return mine;
  }
  const list = base == null ? [] : base;
  if (isKeyedList(list) && isKeyedList(mine) && isKeyedList(theirs)) {
    return mergeList(list, mine, theirs);
  }
  if (isRecord(mine) && isRecord(theirs)) {
    return mergeRecord(isRecord(base) ? base : {}, mine, theirs);
  }
  return mine;
}

function mergeRecord(base: Record<string, unknown>, mine: Record<string, unknown>, theirs: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    // An empty field keeps this tab's spelling of empty, e.g. genvideo: null.
    const v = merge(base[k], mine[k], theirs[k]);
    if (v == null && mine[k] === null) {
      out[k] = null;
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** Items merge by id in the stored copy's order. An item one side removed
 * stays removed unless the other side changed it; a removal and an edit to
 * the same item settle the way the person's side did. Items this tab added
 * sit after the item they followed here, e.g. a clip dropped between two. */
function mergeList(base: Keyed[], mine: Keyed[], theirs: Keyed[]): Keyed[] {
  const was = new Map(base.map((item) => [item.id, item]));
  const ours = new Map(mine.map((item) => [item.id, item]));
  const out: Keyed[] = [];

  // Their items, merged with ours where both still hold them.
  for (const item of theirs) {
    const old = was.get(item.id);
    const own = ours.get(item.id);
    if (!own) {
      // Gone here: removed by this tab, unless it never had it.
      if (!old) {
        out.push(item);
      }
      continue;
    }
    out.push(merge(old, own, item) as Keyed);
  }

  // Ours that they no longer hold: this tab's additions, and items they
  // removed that this tab changed meanwhile.
  const placed = new Set(out.map((item) => item.id));
  mine.forEach((item, at) => {
    if (placed.has(item.id)) {
      return;
    }
    const old = was.get(item.id);
    if (old && same(old, item)) {
      return;
    }
    const before = mine.slice(0, at).reverse().find((prev) => placed.has(prev.id));
    const spot = before ? out.findIndex((x) => x.id === before.id) + 1 : 0;
    out.splice(spot, 0, item);
    placed.add(item.id);
  });
  return out;
}

/** The document that carries both writers' changes: `base` is what this tab
 * last synced with the stored copy, `mine` what it holds now, and `theirs`
 * the stored copy that moved on. Only the fields this tab saves are merged. */
export function reconcileDoc(
  base: Partial<ProjectDoc>,
  mine: Partial<ProjectDoc>,
  theirs: Partial<ProjectDoc>
): Partial<ProjectDoc> {
  return mergeRecord(
    base as Record<string, unknown>,
    mine as Record<string, unknown>,
    Object.fromEntries(Object.keys(mine).map((k) => [k, (theirs as Record<string, unknown>)[k]]))
  ) as Partial<ProjectDoc>;
}

/** Whether the stored copy already holds every field this tab saves. */
export function sameDoc(mine: Partial<ProjectDoc>, theirs: Partial<ProjectDoc>): boolean {
  return Object.entries(mine).every(([k, v]) => same(v, (theirs as Record<string, unknown>)[k]));
}
