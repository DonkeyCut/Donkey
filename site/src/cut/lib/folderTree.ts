/**
 * Folders that file into folders. Every folder table — project folders,
 * library folders, note folders, on every shelf — carries `parentId`, null
 * for the top level, and these are the rules they all share: a folder never
 * files under itself, a deleted folder takes everything under it with it, and
 * a parent nothing answers for reads as the top level.
 */

export interface TreeFolder {
  id: string;
  parentId?: string | null;
}

export const parentOf = (f: TreeFolder): string | null => f.parentId ?? null;

/** Whether `folderId` is `ancestorId` or filed somewhere under it. */
export function folderWithin(
  folders: readonly TreeFolder[],
  folderId: string | null,
  ancestorId: string,
): boolean {
  const parents = new Map(folders.map((f) => [f.id, parentOf(f)]));
  let cur = folderId;
  for (let steps = 0; cur && steps <= folders.length; steps++) {
    if (cur === ancestorId) return true;
    cur = parents.get(cur) ?? null;
  }
  return false;
}

/** The folders from the top level down to `folderId`, the open one last.
 * Empty when nothing answers for the id. */
export function folderTrail<F extends TreeFolder>(
  folders: readonly F[],
  folderId: string | null,
): F[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const trail: F[] = [];
  let cur = folderId ? byId.get(folderId) : undefined;
  while (cur && trail.length <= folders.length) {
    trail.unshift(cur);
    const up = parentOf(cur);
    cur = up ? byId.get(up) : undefined;
  }
  return trail;
}

/** The parent folder `id` may be filed under: one of `folders` that is
 * neither `id` itself nor anything filed under it, or the top level. An id
 * naming nothing files the folder at the top level rather than failing the
 * write — the parent may have been deleted elsewhere while this side was
 * offline — and so does one that would close a loop, which two devices
 * moving folders into each other offline can ask for. */
export function resolveParent(
  folders: readonly TreeFolder[],
  id: string,
  parentId: unknown,
): string | null {
  if (typeof parentId !== "string" || !parentId || parentId === id) return null;
  if (!folders.some((f) => f.id === parentId)) return null;
  if (folderWithin(folders, parentId, id)) return null;
  return parentId;
}

/** `id` and every folder filed under it, however deep: what a delete of `id`
 * takes. A loop in the listing is walked once. */
export function subtreeOf(folders: readonly TreeFolder[], id: string): string[] {
  const under = new Map<string | null, string[]>();
  for (const f of folders) {
    const p = parentOf(f);
    under.set(p, [...(under.get(p) ?? []), f.id]);
  }
  const tree = [id];
  const seen = new Set(tree);
  for (let i = 0; i < tree.length; i++)
    for (const child of under.get(tree[i]) ?? [])
      if (!seen.has(child)) {
        seen.add(child);
        tree.push(child);
      }
  return tree;
}

/** The items filed in `id` or any folder under it, however deep: what the
 * folder holds. */
export function subtreeItems<T extends { folderId?: string | null }>(
  folders: readonly TreeFolder[],
  items: readonly T[],
  id: string,
): T[] {
  const tree = new Set(subtreeOf(folders, id));
  return items.filter((item) => !!item.folderId && tree.has(item.folderId));
}

/** Every folder's total of `weigh` over the items filed in it or anywhere
 * under it, in one pass: each folder's own sum climbs to every folder above
 * it. A loop in the listing is climbed once. */
export function subtreeTotals<T extends { folderId?: string | null }>(
  folders: readonly TreeFolder[],
  items: readonly T[],
  weigh: (item: T) => number,
): Map<string, number> {
  // Each folder's own sum, before anything climbs.
  const own = new Map<string, number>();
  for (const item of items) {
    if (!item.folderId) {
      continue;
    }
    own.set(item.folderId, (own.get(item.folderId) ?? 0) + weigh(item));
  }

  // Climb each sum up the parent chain, stopping at a folder already passed.
  const parents = new Map(folders.map((f) => [f.id, parentOf(f)]));
  const totals = new Map<string, number>(folders.map((f) => [f.id, 0]));
  for (const [id, sum] of own) {
    const seen = new Set<string>();
    let cur: string | null = id;
    while (cur && parents.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      totals.set(cur, (totals.get(cur) ?? 0) + sum);
      cur = parents.get(cur) ?? null;
    }
  }
  return totals;
}

/** The folders filed right under `parentId` (null for the top level). */
export function childrenOf<F extends TreeFolder>(
  folders: readonly F[],
  parentId: string | null,
): F[] {
  return folders.filter((f) => parentOf(f) === parentId);
}

/** A listing with every parent the listing does not name read as the top
 * level, so nothing hangs off a folder nobody can open. */
export function settleParents<F extends TreeFolder>(folders: readonly F[]): F[] {
  const known = new Set(folders.map((f) => f.id));
  return folders.map((f) =>
    f.parentId && !known.has(f.parentId) ? { ...f, parentId: null } : f,
  );
}
