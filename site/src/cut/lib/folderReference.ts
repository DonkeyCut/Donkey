import { z } from "zod";
import type { AssetRef } from "@/cut/lib/assetRef";
import { normalizeLink } from "@/cut/lib/link";
import { folderTrail } from "@/cut/lib/folderTree";
import type { LibraryFolder } from "@/cut/lib/library";
import type { MediaFolder } from "@/cut/lib/types";

const id = z.string().min(1).max(128);
export const folderReferenceSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("project"), folderId: id, projectId: id }),
  z.object({ scope: z.literal("library"), folderId: id, residency: z.enum(["browser", "local", "cloud"]).optional() }),
  z.object({ scope: z.literal("shared"), shareToken: z.string().regex(/^[A-Za-z0-9_-]{32}$/), folderId: id.optional() }),
]);
export const folderReadSchema = z.object({
  reference: folderReferenceSchema.optional(),
  link: z.string().optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100),
});


export type FolderReference = z.infer<typeof folderReferenceSchema>;

export function folderRef(folder: FolderReference, name: string): AssetRef {
  const key = folder.scope === "project" ? folder.projectId
    : folder.scope === "library" ? folder.residency ?? "" : folder.shareToken;
  const identity = `${folder.scope}:${key}:${folder.folderId ?? ""}`;
  return {
    scope: "folder", id: identity, name: name.replace(/"/g, "”").replace(/\s+/g, " "), kind: "text", folder,
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(JSON.stringify({ tool: "read_folder", reference: folder }))}`,
  };
}

export function projectFolderRef(folder: MediaFolder, projectId: string): AssetRef {
  return folderRef({ scope: "project", folderId: folder.id, projectId }, `Project / ${folder.name}`);
}

export function libraryFolderRef(folder: LibraryFolder, folders: LibraryFolder[]): AssetRef {
  const path = folderTrail(folders.filter((f) => f.residency === folder.residency), folder.id).map((f) => f.name).join(" / ");
  const shelf = { browser: "Browser", local: "Mac", cloud: "Cloud" }[folder.residency];
  return folderRef({ scope: "library", folderId: folder.id, residency: folder.residency }, `Library · ${shelf} / ${path}`);
}

/** Build shelf paths once when the listing changes. */
export function libraryFolderRefs(folders: LibraryFolder[]): AssetRef[] {
  const keyOf = (f: LibraryFolder) => `${f.residency}:${f.id}`;
  const byId = new Map(folders.map((f) => [keyOf(f), f]));
  const paths = new Map<string, string>();
  return folders.map((folder) => {
    const trail: LibraryFolder[] = [];
    const seen = new Set<string>();
    let current: LibraryFolder | undefined = folder;
    while (current && !paths.has(keyOf(current)) && !seen.has(keyOf(current))) {
      trail.push(current);
      seen.add(keyOf(current));
      current = current.parentId ? byId.get(`${current.residency}:${current.parentId}`) : undefined;
    }
    let path = current ? paths.get(keyOf(current)) ?? "" : "";
    for (const entry of trail.reverse()) {
      path = path ? `${path} / ${entry.name}` : entry.name;
      paths.set(keyOf(entry), path);
    }
    const shelf = { browser: "Browser", local: "Mac", cloud: "Cloud" }[folder.residency];
    return folderRef({ scope: "library", folderId: folder.id, residency: folder.residency }, `Library · ${shelf} / ${paths.get(keyOf(folder))}`);
  });
}

/** Called on a tool's URL argument after the model chooses what to open. */
export function parseFolderLink(value: string): FolderReference | null {
  let url: URL;
  try { url = new URL(normalizeLink(value)); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (!["donkeycut.com", "www.donkeycut.com", "localhost", "cut.localhost", "127.0.0.1"].includes(url.hostname)) return null;
  const path = url.pathname.replace(/^\/cut\//, "/").replace(/\/$/, "");
  const folderId = url.searchParams.get("folder") ?? undefined;
  const share = /^\/s\/library\/([^/]+)$/.exec(path);
  const project = /^\/app\/p\/([^/]+)$/.exec(path);
  const candidate = share ? { scope: "shared", shareToken: share[1], folderId }
    : path === "/app/library" ? { scope: "library", folderId }
      : project ? { scope: "project", projectId: project[1], folderId } : null;
  const parsed = folderReferenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
