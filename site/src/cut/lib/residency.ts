// Where a project lives is a fact about the project, not the link that opened
// it: the editor resolves residency by asking, so URLs stay clean. With the
// web-mode flag off everything is local (today's behavior). Otherwise the
// engine — when one is already connected; loopback is never probed here, so
// the browser's local-network ask can't fire — is asked whether it owns the
// id, and a miss means the project is cloud-resident.
import { engineOrigin, servedFromEngine } from "./api";
import { localBackend } from "./backend/local";
import type { CutMode } from "./backend/types";
import { webModeEnabled } from "./flags";

export async function resolveProjectMode(projectId: string): Promise<CutMode> {
  if (!webModeEnabled()) return "local";
  if (!servedFromEngine() && !engineOrigin()) return "cloud";
  try {
    // HEAD: the question is whether the engine owns the id, and the answer is
    // the status. The doc itself is fetched a moment later by the load.
    const res = await localBackend.fetch(`/api/cut/projects/${projectId}`, { method: "HEAD" });
    if (res.ok) return "local";
  } catch {
    // The engine dropped since the gate probed it; the cloud copy (if any)
    // is the only reachable one.
  }
  return "cloud";
}
