/**
 * Folders that file into folders. Every folder table — project folders,
 * library folders, note folders, on every shelf — carries `parentId`, null
 * for the top level, and these are the rules they all share: a folder never
 * files under itself, what a deleted folder held comes up one level, and a
 * parent nothing answers for reads as the top level.
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
