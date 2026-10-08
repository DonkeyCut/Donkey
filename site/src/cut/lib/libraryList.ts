import type { LibraryAsset, LibraryFolder } from "./library";

// The chat reads the shelf a page at a time: a whole Library with every
// phone clip's description runs past what the model can read, and then it
// cannot find the one asset the user named.

export const LIBRARY_PAGE_DEFAULT = 40;
export const LIBRARY_PAGE_MAX = 200;

export type LibraryListTemplate = { id: string; name: string; duration: number; parts: number; folderId?: string | null };
export type LibraryListInput = { query?: unknown; folder?: unknown; kind?: unknown; offset?: unknown; limit?: unknown };

/** Names compare without case, and with hyphens, underscores, dots and spaces alike. */
export function libraryMatchKey(text: string): string {
  return text.toLowerCase().replace(/[-_.\s]+/g, " ").trim();
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const stem = (fileName: string) => fileName.replace(/\.[^.]+$/, "");

function folderScope(folders: LibraryFolder[], folder: string): Set<string> | undefined {
  const key = libraryMatchKey(folder);
  const root = folders.find((f) => f.id === folder) ?? folders.find((f) => libraryMatchKey(f.name) === key);
  if (!root) return undefined;
  const scope = new Set([root.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && scope.has(f.parentId) && !scope.has(f.id)) { scope.add(f.id); grew = true; }
    }
  }
  return scope;
}

/** One page of the shelf, narrowed by words in a name, a folder (and the
 * folders inside it) and a kind. */
export function listLibrary(
  lib: { assets: LibraryAsset[]; folders: LibraryFolder[]; templates: LibraryListTemplate[] },
  input: LibraryListInput,
) {
  const words = typeof input.query === "string" ? libraryMatchKey(input.query).split(" ").filter(Boolean) : [];
  const matches = (...texts: (string | undefined)[]) => {
    const hay = libraryMatchKey(texts.filter(Boolean).join(" "));
    return words.every((word) => hay.includes(word));
  };
  const folder = typeof input.folder === "string" && input.folder ? input.folder : undefined;
  const scope = folder ? folderScope(lib.folders, folder) : undefined;
  if (folder && !scope) {
    return { error: `No Library folder named "${folder}".`, folders: lib.folders.map((f) => ({ id: f.id, name: f.name, ...(f.parentId ? { parentId: f.parentId } : {}) })) };
  }
  const inScope = (folderId: string | null | undefined) => !scope || (!!folderId && scope.has(folderId));
  const kind = typeof input.kind === "string" && input.kind ? input.kind : undefined;
  const offset = typeof input.offset === "number" && Number.isSafeInteger(input.offset) && input.offset > 0 ? input.offset : 0;
  const limit = typeof input.limit === "number" && input.limit >= 1 ? Math.min(Math.floor(input.limit), LIBRARY_PAGE_MAX) : LIBRARY_PAGE_DEFAULT;

  const folders = lib.folders
    .filter((f) => (scope ? scope.has(f.id) : true) && (!words.length || matches(f.name)))
    .map((f) => ({ id: f.id, name: f.name, ...(f.parentId ? { parentId: f.parentId } : {}) }));
  const items = [
    ...(kind === "template" ? [] : lib.assets
      .filter((a) => (!kind || a.type === kind) && inScope(a.folderId) && matches(a.name, a.title, stem(a.fileName)))
      .map((a) => ({
        id: a.id,
        name: a.name,
        // Read off the clip itself — what is said in it and what is on
        // screen. A phone recording's own name is the clock it was shot on,
        // so this is what says which clip it is.
        ...(a.title ? { title: a.title } : {}),
        kind: a.type as string,
        duration: round2(a.duration),
        ...(a.folderId ? { folderId: a.folderId } : {}),
        // "camera" = recorded on the user's phone (their Camera Roll);
        // "inspiration" = saved from the phone's Ideas tab.
        ...(a.origin ? { origin: a.origin } : {}),
      }))),
    ...(kind && kind !== "template" ? [] : lib.templates
      .filter((t) => inScope(t.folderId) && matches(t.name))
      .map((t) => ({ id: t.id, name: t.name, kind: "template", duration: round2(t.duration), parts: t.parts, ...(t.folderId ? { folderId: t.folderId } : {}) }))),
  ];
  const page = items.slice(offset, offset + limit);
  return {
    folders,
    items: page,
    total: items.length,
    ...(offset + limit < items.length ? { next: offset + limit } : {}),
  };
}

/** The Library asset a chat named by id, or by its name or file name with
 * case, hyphens and spaces ignored. Several with that name come back as
 * candidates for the model to choose from. */
export function findLibraryAsset(
  assets: LibraryAsset[],
  ref: string,
): { asset: LibraryAsset } | { candidates: { id: string; name: string; folderId?: string | null }[] } | undefined {
  const byId = assets.find((a) => a.id === ref);
  if (byId) return { asset: byId };
  const key = libraryMatchKey(ref);
  if (!key) return undefined;
  const named = assets.filter((a) => libraryMatchKey(a.name) === key || libraryMatchKey(stem(a.fileName)) === key || libraryMatchKey(a.fileName) === key);
  if (named.length === 1) return { asset: named[0] };
  if (named.length > 1) return { candidates: named.map((a) => ({ id: a.id, name: a.name, ...(a.folderId ? { folderId: a.folderId } : {}) })) };
  return undefined;
}
