import { backendFor, type Residency } from "@/cut/lib/residency";
import { cloudBackend } from "@/cut/lib/backend/cloud";
import { presignedUpload } from "@/cut/lib/media";
import {
  createLibraryFolder, deleteFromLibrary, deleteLibraryFolder, deleteTemplate,
  moveLibraryItem, type LibraryData, type LibraryAsset, type LibraryTemplateItem,
} from "@/cut/lib/library";
import type { LibraryShareTarget } from "@/cut/lib/librarySharing";
import { UserError } from "@/cut/lib/userError";

async function uploadFile(residency: Residency, fileName: string) {
  const response = await backendFor(residency).fetch(`/api/cut/library/media/${encodeURIComponent(fileName)}`);
  if (!response.ok) throw new UserError("share_file_read_failed", "Could not read the file for sharing.");
  const blob = await response.blob();
  return presignedUpload("/api/cut/library/presign", blob, fileName, cloudBackend);
}

/** A cloud copy is independent of the local shelf. Only a completed copy is shared. */
export async function copyLibraryForSharing(
  target: LibraryShareTarget,
  residency: Residency,
  library: LibraryData,
): Promise<LibraryShareTarget> {
  if (residency === "cloud") return target;
  const assets: string[] = [];
  const templates: string[] = [];
  const folders: string[] = [];
  const copyAsset = async (asset: LibraryAsset, folderId: string | null) => {
    const key = await uploadFile(residency, asset.fileName);
    const posterKey = asset.posterFile ? await uploadFile(residency, asset.posterFile) : undefined;
    const response = await cloudBackend.fetch("/api/cut/library/complete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, posterKey, meta: {
        name: asset.title || asset.name, type: asset.type, duration: asset.duration,
        width: asset.width, height: asset.height, source: asset.source,
      } }),
    });
    if (!response.ok) throw new UserError("share_asset_copy_failed", "Could not copy the asset to Cloud.");
    const landed = await response.json() as { id: string };
    assets.push(landed.id);
    if (folderId) await moveLibraryItem("cloud", landed.id, folderId);
    return landed.id;
  };
  const copyTemplate = async (template: LibraryTemplateItem, folderId: string) => {
    const keys: string[] = [];
    for (const media of template.media) keys.push(await uploadFile(residency, media.fileName));
    const response = await cloudBackend.fetch("/api/cut/library/templates/import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...template, folderId, keys }),
    });
    if (!response.ok) throw new UserError("share_template_copy_failed", "Could not copy the template to Cloud.");
    const landed = await response.json() as { id: string };
    templates.push(landed.id);
  };
  try {
    if (target.kind === "asset") {
      const asset = library.assets.find((a) => a.id === target.id && a.residency === residency);
      if (!asset) throw new UserError("asset_not_found", "Asset not found.");
      return { kind: "asset", id: await copyAsset(asset, null) };
    }
    const sourceFolders = library.folders.filter((f) => f.residency === residency);
    const root = sourceFolders.find((f) => f.id === target.id);
    if (!root) throw new UserError("folder_not_found", "Folder not found.");
    const group = <T,>(items: T[], parentOf: (item: T) => string | null) => {
      const groups = new Map<string | null, T[]>();
      for (const item of items) {
        const parent = parentOf(item);
        const children = groups.get(parent) ?? [];
        children.push(item);
        groups.set(parent, children);
      }
      return groups;
    };
    const folderChildren = group(sourceFolders, (f) => f.parentId ?? null);
    const folderAssets = group(library.assets.filter((a) => a.residency === residency), (a) => a.folderId ?? null);
    const folderTemplates = group(library.templates.filter((t) => t.residency === residency), (t) => t.folderId ?? null);
    const todo = [{ folder: root, parent: null as string | null }];
    const seen = new Set<string>();
    let rootId = "";
    for (let i = 0; i < todo.length; i++) {
      const { folder, parent } = todo[i];
      if (seen.has(folder.id)) throw new UserError("folder_cycle", "This folder contains a cycle.");
      seen.add(folder.id);
      const copy = await createLibraryFolder(folder.name, "cloud", parent);
      folders.push(copy.id);
      if (!rootId) rootId = copy.id;
      for (const asset of folderAssets.get(folder.id) ?? [])
        await copyAsset(asset, copy.id);
      for (const template of folderTemplates.get(folder.id) ?? [])
        await copyTemplate(template, copy.id);
      for (const child of folderChildren.get(folder.id) ?? []) todo.push({ folder: child, parent: copy.id });
    }
    return { kind: "folder", id: rootId };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      ...assets.map((id) => deleteFromLibrary("cloud", id)),
      ...templates.map((id) => deleteTemplate("cloud", id)),
    ]);
    for (const id of folders.reverse()) {
      cleanup.push(...await Promise.allSettled([deleteLibraryFolder("cloud", id)]));
    }
    if (cleanup.some((result) => result.status === "rejected"))
      throw new UserError("share_copy_leftovers", "Copy failed. Some unshared copies remain in your Cloud library; remove them before retrying.");
    throw error;
  }
}
