// A Donkey Cut link as the assistant's tools take it: the project page
// (/app/p/<id>), a share link (/s/<token>), or a bare project id. The model
// hands the link over in a typed argument; this only reads its shape. What
// the link opens — the project's home, the share's grant — is the reader's
// to resolve.

import type { AssetRef } from "./assetRef";
import { normalizeLink } from "./link";

/** How many projects one list_projects page carries by default, and at most. */
export const PROJECT_PAGE_DEFAULT = 100;
export const PROJECT_PAGE_MAX = 500;

export type ProjectLink = { kind: "project"; id: string } | { kind: "share"; token: string };

const ID_RE = /^[A-Za-z0-9_-]+$/;

/** The project page and the share page, with or without the physical /cut
 * prefix the host rewrite hides. */
const PROJECT_PATH = /^\/(?:cut\/)?app\/p\/([^/]+)\/?$/;
const SHARE_PATH = /^\/(?:cut\/)?s\/([^/]+)\/?$/;

export function parseProjectLink(value: string): ProjectLink | null {
  const v = value.trim();
  if (!v || /\s/.test(v)) return null;
  if (ID_RE.test(v)) return { kind: "project", id: v };
  let url: URL;
  try {
    url = new URL(normalizeLink(v));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const path = decodeURIComponent(url.pathname);
  const project = PROJECT_PATH.exec(path);
  if (project && ID_RE.test(project[1])) return { kind: "project", id: project[1] };
  const share = SHARE_PATH.exec(path);
  if (share && ID_RE.test(share[1])) return { kind: "share", token: share[1] };
  return null;
}

/** Another of the user's projects as a chat attachment. It carries the id, so
 * the reference holds through a rename; read_project returns the current
 * title. */
export function projectDocRef(project: { id: string; name: string }): AssetRef {
  return {
    scope: "projectDoc",
    id: project.id,
    name: `Projects / ${project.name || "Untitled"}`.replace(/"/g, "”").replace(/\s+/g, " "),
    kind: "text",
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(JSON.stringify({ tool: "read_project", link: project.id }))}`,
  };
}
