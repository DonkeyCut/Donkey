import { fetchNotes } from "@/cut/lib/notes";
import { linkIdForAsset } from "@/cut/lib/linkedLibrary/registry";
import type { LibraryAsset } from "@/cut/lib/library";
import { cloudRequest } from "@/cut/lib/backend/cloud";
import { folderReadSchema, parseFolderLink, type FolderReference } from "@/cut/lib/folderReference";
import type { LibraryData } from "@/cut/lib/library";
import type { SharedLibraryPage } from "@/cut/lib/librarySharing";
import { openReference } from "@/cut/lib/projectReference";
import { backendFor } from "@/cut/lib/residency";
import { useEditor } from "@/cut/lib/store";
import type { LibraryTemplate, StoredAsset } from "@/cut/lib/types";


export async function sharedFolderPage(reference: Extract<FolderReference, { scope: "shared" }>, offset: number): Promise<SharedLibraryPage> {
  const params = new URLSearchParams({ offset: String(offset) });
  if (reference.folderId) params.set("folder", reference.folderId);
  const res = await cloudRequest(`/api/cut-shared/library/${encodeURIComponent(reference.shareToken)}?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not open the shared folder (${res.status}). Check the link and this account's access.`);
  return res.json();
}

export async function readFolder(raw: unknown) {
  const input = folderReadSchema.parse(raw);
  const reference = input.reference ?? (input.link ? parseFolderLink(input.link) : null);
  if (!reference) throw new Error("Provide a folder reference or a Donkey folder link.");
  if (reference.scope === "shared") {
    const page = await sharedFolderPage(reference, input.offset);
    return { ...page, reference,
      share_link: `https://donkeycut.com/s/library/${reference.shareToken}`,
      folder_id: page.trail.at(-1)?.id,
      folders: page.folders.map((f) => ({ ...f, reference: { ...reference, folderId: f.id } })),
      import: "library_add with share_link, folder_id and offset from this page; for a template file use its template id and template_file", offset: input.offset };
  }
  const state = useEditor.getState();
  let folders: { id: string; name: string; parentId?: string | null }[];
  let assets: (Pick<StoredAsset, "id" | "name" | "type" | "duration" | "folderId"> & Partial<Pick<LibraryAsset, "title">>)[];
  let templates: LibraryTemplate[];
  let notes: Awaited<ReturnType<typeof fetchNotes>>["notes"] = [];
  if (reference.scope === "project") {
    const doc = reference.projectId === state.projectId ? state
      : (await openReference({ kind: "project", id: reference.projectId })).doc;
    folders = doc.mediaFolders ?? [];
    assets = doc.assets ?? [];
    templates = doc.templates ?? [];
  } else {
    // A typed shelf reference reads exactly that shelf; a URL locates its id
    // through the account's available shelves.
    const { fetchLibrary } = await import("@/cut/lib/library");
    let lib: LibraryData;
    if (reference.residency) {
      const res = await backendFor(reference.residency).fetch("/api/cut/library");
      if (!res.ok) throw new Error(`Could not read the ${reference.residency} library (${res.status}).`);
      lib = await res.json();
    } else lib = await fetchLibrary();
    folders = lib.folders;
    assets = lib.assets;
    templates = lib.templates;
    const residency = reference.residency ?? lib.folders.find((f) => f.id === reference.folderId)?.residency;
    notes = (await fetchNotes()).notes.filter((n) => n.libraryLocation?.folderId === reference.folderId && n.libraryLocation.residency === residency);
  }
  const folder = folders.find((f) => f.id === reference.folderId);
  if (!folder) throw new Error("This folder was deleted or is unavailable on this surface.");
  const entries = [
    ...notes.map((n) => ({ kind: "note", id: n.id, name: n.title, tool: "read_note" })),
    ...folders.filter((f) => f.parentId === folder.id).map((f) => ({ kind: "folder", id: f.id, name: f.name, reference: { ...reference, folderId: f.id } })),
    ...assets.filter((a) => a.folderId === folder.id).map((a) => ({ kind: a.type, id: a.id, name: a.title || a.name, duration: a.duration,
      ...(a.type === "font" && linkIdForAsset(a.id) ? { fontId: linkIdForAsset(a.id) } : {}),
      ...(linkIdForAsset(a.id) ? { linkedId: linkIdForAsset(a.id) } : {}),
    })),
    ...templates.filter((t) => t.folderId === folder.id).map((t) => ({ kind: "template", id: t.id, name: t.name, duration: t.duration })),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const end = input.offset + input.limit;
  return { reference, name: folder.name, entries: entries.slice(input.offset, end), total: entries.length,
    next: end < entries.length ? end : null,
    usage: reference.scope === "library" ? "Use read_note for notes; use library_add for chosen media or to resolve a linked item id; restore templates with template_add."
      : reference.projectId === state.projectId ? "Use asset ids directly; restore templates with template_add."
        : `Use copy_project_media with link ${reference.projectId} for chosen assets.` };
}
