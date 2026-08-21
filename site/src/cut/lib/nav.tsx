"use client";

import { CUT_APP_BASE } from "./appBase";

export { CUT_APP_BASE };

export function useCutBase(): string {
  return CUT_APP_BASE;
}

// The project editor can be reached from either home tab, from inside a
// folder or not. The origin rides along in the project URL (?from=… and
// ?folder=…) so the editor's back button returns to the exact place the
// project was opened from — Projects, Library, or a folder within one. The
// home pages read ?folder=… as the open folder, which also lets the browser's
// own back button step folder → root.
export type CutTab = "projects" | "library" | "camera-roll" | "notes";

/** Which home tab a pathname is on (base-agnostic). */
export function tabForPath(pathname: string): CutTab {
  if (pathname.endsWith("/library")) return "library";
  if (pathname.endsWith("/camera-roll")) return "camera-roll";
  if (pathname.endsWith("/notes")) return "notes";
  return "projects";
}

/** Home tab URL under the given base, optionally inside a folder. Projects is
 * the base root. */
export function homeHref(base: string, tab: CutTab, folder?: string | null): string {
  const root = tab === "projects" ? base || "/" : `${base}/${tab}`;
  return folder ? `${root}?folder=${encodeURIComponent(folder)}` : root;
}

/** Project editor URL that remembers the tab (and folder, when open) it was
 * opened from. The default origin carries no query so the common URL stays
 * clean. Residency never rides the URL — the editor resolves where the id
 * lives (lib/residency.ts). */
export function projectHref(
  base: string,
  id: string,
  from: CutTab,
  folder?: string | null
): string {
  const params = new URLSearchParams();
  if (from === "library") params.set("from", "library");
  if (folder) params.set("folder", folder);
  const qs = params.toString();
  return `${base}/p/${id}${qs ? `?${qs}` : ""}`;
}

/** Where the editor's back button goes, and the tab it is named for. An unknown
 * origin falls back to Projects. */
export function backTarget(
  base: string,
  from: string | null | undefined,
  folder?: string | null
): { href: string; tab: CutTab } {
  const tab: CutTab = from === "library" ? "library" : "projects";
  return { href: homeHref(base, tab, folder), tab };
}
