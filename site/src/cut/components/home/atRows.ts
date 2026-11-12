// The rows Home's `@` picker lists, and how a tab and a query narrow them.
//
// Every row is a ref the chat already knows how to read — a Library file, a
// folder, a note, a project, a template — plus what the picker needs to draw
// it: which tab it sits under, how recent it is, and what its thumbnail shows.
import type { AssetRef } from "@/cut/lib/assetRef";
import type { LibraryAsset } from "@/cut/lib/library";
import type { Residency } from "@/cut/lib/residency";
import type { GalleryTemplate } from "@/cut/lib/templateGallery";
import type { ProjectSummary } from "@/cut/lib/types";

/** The picker's tabs, in the order they show. */
export const AT_TABS = ["all", "folders", "clips", "images", "audio", "notes", "snippets", "projects", "templates"] as const;
export type AtTab = (typeof AT_TABS)[number];

/** A template a new project can start from, the way Use as new project
 * starts one: one of Donkey's, or one of the person's own. */
export type StartTemplate =
  | { kind: "gallery"; template: GalleryTemplate }
  | { kind: "own"; project: ProjectSummary; residency: Residency };

/** What a row's thumbnail shows. Media plays inside it while the row is
 * active; the rest draw a plain icon. */
export type AtPreview =
  | { kind: "library"; asset: LibraryAsset }
  | { kind: "project"; project: ProjectSummary; residency: Residency }
  | { kind: "template"; poster: string }
  /** A Library template: the first picture it lays in, a still or a clip's
   * opening frame. */
  | { kind: "templateMedia"; src: string; media: "image" | "video" }
  /** A note, on its own paper colour. */
  | { kind: "note"; colorIndex: number; body: string }
  /** A Library file with no tab of its own: a font, a LUT. */
  | { kind: "file"; asset: LibraryAsset }
  | { kind: "icon"; icon: "folder" | "note" | "file" };

export interface AtRow {
  ref: AssetRef;
  /** What the row reads as: the thing's own name, where the ref's name
   * carries a path for the chat ("Library · Cloud / Trips"). */
  label: string;
  /** The tab it sits under besides All; null lists it under All only. */
  tab: Exclude<AtTab, "all"> | null;
  /** When it last changed, for the recent list; 0 keeps it out. */
  at: number;
  preview: AtPreview;
  /** Set on a template that becomes the new project's starting structure. */
  start?: StartTemplate;
}

/** How many recent rows show before anything is typed. */
export const RECENT_ROWS = 8;

/** How many rows a typed query lists. */
export const MATCH_ROWS = 40;

/** The rows a tab and a query keep. Nothing typed lists the most recent
 * rows, newest first, and a template tab with nothing recent lists its
 * templates in order. Typed text keeps names that start with it, then names
 * that hold it anywhere. */
export function filterAtRows(rows: readonly AtRow[], tab: AtTab, query: string): AtRow[] {
  const inTab = tab === "all" ? rows : rows.filter((r) => r.tab === tab);
  const q = query.trim().toLowerCase();

  // Before typing: the recent rows, or the tab's own order where it has no clock.
  if (!q) {
    const recent = inTab.filter((r) => r.at > 0).sort((a, b) => b.at - a.at);
    return (recent.length > 0 ? recent : inTab).slice(0, RECENT_ROWS);
  }

  // Typed: name prefix first, then anywhere in the name.
  const rank = (r: AtRow) => {
    const name = r.label.toLowerCase();
    return name.startsWith(q) ? 0 : name.includes(q) ? 1 : 2;
  };
  return inTab
    .map((r) => ({ r, k: rank(r) }))
    .filter((x) => x.k < 2)
    .sort((a, b) => a.k - b.k)
    .slice(0, MATCH_ROWS)
    .map((x) => x.r);
}

/** Names a mention resolves by, made unique: a second row with a name already
 * taken carries its id, so every pick resolves to the row that was picked. */
export function uniqueNames(rows: readonly AtRow[]): AtRow[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const key = row.ref.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      return row;
    }
    const name = `${row.ref.name} [${row.ref.id}]`;
    seen.add(name.toLowerCase());
    return { ...row, ref: { ...row.ref, name } };
  });
}

/** The tab a Library file sits under; null for a file the chat acts on by
 * tool rather than as media (a LUT), which lists under All only. */
export function libraryTab(type: LibraryAsset["type"]): AtRow["tab"] | null {
  if (type === "video") {
    return "clips";
  }
  if (type === "image") {
    return "images";
  }
  if (type === "audio") {
    return "audio";
  }
  return null;
}

/** The id prefix of a ref naming a template to start from. */
export const START_TEMPLATE_PREFIX = "start-template:";

/** A template to start from as a ref, so it pills in the prompt like any
 * other pick. It never reaches the chat: sending starts the project from the
 * template and takes the ref out of the message. */
export function startTemplateRef(start: StartTemplate, name: string): AssetRef {
  const id = start.kind === "gallery" ? start.template.id : start.project.id;
  return {
    scope: "entity",
    id: `${START_TEMPLATE_PREFIX}${start.kind}:${id}`,
    name: `${name} template`,
    kind: "text",
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(`the "${name}" template, the new project's starting structure`)}`,
    entityKind: "template",
  };
}

/** Whether a ref names a template to start from. */
export const isStartTemplateRef = (ref: Pick<AssetRef, "id">) => ref.id.startsWith(START_TEMPLATE_PREFIX);
