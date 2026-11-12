"use client";

import { CUT_APP_BASE } from "./appBase";

export { CUT_APP_BASE };

export function useCutBase(): string {
  return CUT_APP_BASE;
}

// The project editor can be reached from Home, from Assets (inside a folder or
// not), or from a template. The origin rides along in the project URL
// (?from=… and ?folder=…) so the editor's back button returns to the exact
// place the project was opened from. Assets reads ?folder=… as the open
// folder, which also lets the browser's own back button step folder → root.
export type CutTab = "home" | "assets" | "templates";

/** The type tabs Assets filters by; "all" is its default and rides no query. */
export const ASSET_TYPES = ["all", "projects", "videos", "images", "audio", "fonts", "notes"] as const;
export type AssetTypeTab = (typeof ASSET_TYPES)[number];

/** Which home tab a pathname is on (base-agnostic). */
export function tabForPath(pathname: string): CutTab {
  if (pathname.endsWith("/assets")) return "assets";
  if (pathname.endsWith("/templates")) return "templates";
  return "home";
}

/** Home tab URL under the given base, optionally inside a folder. Home is the
 * base root; only Assets has folders. */
export function homeHref(base: string, tab: CutTab, folder?: string | null): string {
  const root = tab === "home" ? base || "/" : `${base}/${tab}`;
  return folder ? `${root}?folder=${encodeURIComponent(folder)}` : root;
}

/** Assets on one type tab, optionally inside a folder. */
export function assetsHref(base: string, type: AssetTypeTab, folder?: string | null): string {
  const params = new URLSearchParams();
  if (folder) params.set("folder", folder);
  params.set("type", type);
  const qs = params.toString();
  return `${base}/assets${qs ? `?${qs}` : ""}`;
}

// The origins an editor's back button returns to by name. Links minted before
// Assets replaced Projects and Library say "library", or carry only a folder;
// both go back to Assets. Any other origin goes back to Home.
const BACK_TABS: readonly CutTab[] = ["assets", "templates"];
const LEGACY_ASSET_ORIGINS: readonly string[] = ["library", "projects"];

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
  if (BACK_TABS.includes(from)) {
    params.set("from", from);
  }
  if (folder) params.set("folder", folder);
  const qs = params.toString();
  return `${base}/p/${id}${qs ? `?${qs}` : ""}`;
}

/** Where the editor's back button goes, and the tab it is named for. A folder
 * only exists in Assets, so a link that names one goes back there. */
export function backTarget(
  base: string,
  from: string | null | undefined,
  folder?: string | null
): { href: string; tab: CutTab } {
  const named = BACK_TABS.find((b) => b === from);
  const legacy = !!from && LEGACY_ASSET_ORIGINS.includes(from);
  const tab: CutTab = named ?? (legacy || folder ? "assets" : "home");
  return { href: homeHref(base, tab, folder), tab };
}
