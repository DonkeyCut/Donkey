import { cloudBackend } from "@/cut/lib/backend/cloud";
import { libraryShareApiPath, type LibraryShareTarget, type ShareSettings } from "@/cut/lib/librarySharing";
import type { ShareFeatures } from "@/cut/lib/types";

export type ShareResource = { projectId: string } | { libraryTarget: LibraryShareTarget };
export type SharingSettings = ShareSettings & { features?: ShareFeatures };
export type SharingState = SharingSettings & { id: string };
export const shareEndpoint = (resource: ShareResource) => "projectId" in resource
  ? `/api/cut/projects/${encodeURIComponent(resource.projectId)}/share`
  : libraryShareApiPath(resource.libraryTarget);

export async function requestSharing(resource: ShareResource, method = "GET", settings?: SharingSettings) {
  const response = await cloudBackend.fetch(shareEndpoint(resource), {
    method,
    ...(settings ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) } : {}),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Could not load or save sharing.");
  return await response.json() as { share: SharingState | null };
}
