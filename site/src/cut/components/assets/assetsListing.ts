import type { LibraryAsset, LibraryData, LibraryFolder, LibraryTemplateItem } from "@/cut/lib/library";
import type { AssetTypeTab } from "@/cut/lib/nav";
import type { Residency } from "@/cut/lib/residency";
import { parseRatio, type ProjectFolder, type ProjectSummary } from "@/cut/lib/types";

/** Which store a folder is written through. Every shelf keeps one folder tree
 * in its library store; a Mac engine from before that change still keeps its
 * project folders apart, and those are renamed, moved and deleted through the
 * project routes. */
export type FolderStore = "library" | "projects";

/** A folder on the Assets page: a library folder, tagged with its store. */
export type AssetFolder = LibraryFolder & { store: FolderStore };

/** One card on the Assets page. Projects, library files and saved templates
 * share the grid, newest first. */
export type AssetEntry =
  | { kind: "project"; id: string; name: string; residency: Residency; folderId: string | null; at: number; project: ProjectSummary }
  | { kind: "media"; id: string; name: string; residency: Residency; folderId: string | null; at: number; asset: LibraryAsset }
  | { kind: "template"; id: string; name: string; residency: Residency; folderId: string | null; at: number; template: LibraryTemplateItem };

/** One residency's project listing, as the projects section caches it. */
export type ProjectShelf = { residency: Residency; projects: ProjectSummary[]; folders: ProjectFolder[] };

/** The longest side every picture card takes, in pixels: a tall card is
 * 180 × 320 and a wide one 320 × 180, so the two share a row. */
export const CARD_LONG_SIDE = 320;

// The media types each type tab shows. Projects and notes have tabs of their
// own; every other file type (LUTs) lists under All only.
const TAB_MEDIA: Partial<Record<AssetTypeTab, LibraryAsset["type"]>> = {
  videos: "video",
  images: "image",
  audio: "audio",
  fonts: "font",
};

/**
 * Every folder the page shows, one tree per shelf. The library listing is the
 * truth; a shelf whose project folders still live apart (an older Mac engine)
 * adds the ones the library doesn't hold.
 */
export function mergeFolders(library: LibraryFolder[], shelves: ProjectShelf[]): AssetFolder[] {
  const seen = new Set(library.map((f) => f.id));
  const out: AssetFolder[] = library.map((f) => ({ ...f, store: "library" }));
  for (const shelf of shelves) {
    for (const f of shelf.folders) {
      if (seen.has(f.id)) {
        continue;
      }
      seen.add(f.id);
      out.push({ ...f, parentId: f.parentId ?? null, residency: shelf.residency, store: "projects" });
    }
  }
  return out;
}

/** Every card the page can show, newest first. A project made into a template
 * lists under Templates, so it stays out. */
export function assetEntries(library: LibraryData, shelves: ProjectShelf[]): AssetEntry[] {
  const projects: AssetEntry[] = shelves.flatMap((shelf) =>
    shelf.projects
      .filter((p) => p.kind !== "template")
      .map((p) => ({
        kind: "project" as const,
        id: p.id,
        name: p.name,
        residency: shelf.residency,
        folderId: p.folderId ?? null,
        at: p.updatedAt ?? p.createdAt ?? 0,
        project: p,
      })),
  );
  const media: AssetEntry[] = library.assets.map((a) => ({
    kind: "media",
    id: a.id,
    name: a.name,
    residency: a.residency,
    folderId: a.folderId ?? null,
    at: a.addedAt ?? 0,
    asset: a,
  }));
  const templates: AssetEntry[] = library.templates.map((t) => ({
    kind: "template",
    id: t.id,
    name: t.name,
    residency: t.residency,
    folderId: t.folderId ?? null,
    at: t.addedAt ?? 0,
    template: t,
  }));
  return [...projects, ...media, ...templates].sort((a, b) => b.at - a.at);
}

/** Whether a card belongs on a type tab. Saved templates list under All only. */
export function entryOnTab(entry: AssetEntry, tab: AssetTypeTab): boolean {
  if (tab === "all") {
    return true;
  }
  if (entry.kind === "project") {
    return tab === "projects";
  }
  if (entry.kind === "template") {
    return false;
  }
  return TAB_MEDIA[tab] === entry.asset.type;
}

/** Whether a name holds the search, ignoring case and accents: "cafe" finds
 * "Café". */
export function nameMatches(name: string, query: string): boolean {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return fold(name).includes(fold(query.trim()));
}

/**
 * The card box for a picture: the longest side is `long`, the other follows
 * the frame, so a wide card is as wide as a tall card is tall. Unknown frames
 * stand tall, the shape most projects take.
 */
export function cardBox(frame: { w: number; h: number } | null, long = CARD_LONG_SIDE): { width: number; height: number } {
  const f = frame && frame.w > 0 && frame.h > 0 ? frame : { w: 9, h: 16 };
  if (f.w >= f.h) {
    return { width: long, height: Math.round((long * f.h) / f.w) };
  }
  return { width: Math.round((long * f.w) / f.h), height: long };
}

/** A project's frame, from its aspect ("16:9"); null when the doc has none. */
export function projectFrame(p: ProjectSummary): { w: number; h: number } | null {
  return parseRatio(p.aspect) ?? null;
}

/**
 * The tile area that gives a library picture the same box `cardBox` does:
 * the library card sizes by area, so a long side L over a w × h frame is the
 * area L² · short / long.
 */
export function cardArea(frame: { w: number; h: number }, long = CARD_LONG_SIDE): number {
  const short = Math.min(frame.w, frame.h);
  const longest = Math.max(frame.w, frame.h);
  return Math.round((long * long * short) / longest);
}
