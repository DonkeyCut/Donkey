import { getBackend, type CutBackend, type CutCaps, type CutMode } from "@/cut/lib/backend";
import { captureCloudBackend, cloudBackend, knownDocVersion } from "@/cut/lib/backend/cloud";
import { captureLocalBackend, localBackend } from "@/cut/lib/backend/local";
import { projectRevision } from "@/cut/lib/projectRevision";

/** Execution context captured before asynchronous work starts. Server routes
 * remain responsible for authenticating and authorizing every request. */
export type ProjectOperation = {
  projectId: string;
  residency: CutMode;
  version: string | null;
  backend: CutBackend;
  capabilities: Readonly<CutCaps>;
};

export function projectOperation(projectId: string, backend = getBackend()): ProjectOperation {
  if (backend.kind === "shared") throw new Error("A shared project is read-only.");
  const captured = backend === cloudBackend ? captureCloudBackend() : backend === localBackend ? captureLocalBackend() : backend;
  return {
    projectId, backend: captured, residency: captured.kind,
    version: projectRevision(projectId) ?? (captured.kind === "cloud" ? knownDocVersion(projectId) : null),
    capabilities: { ...captured.caps },
  };
}
