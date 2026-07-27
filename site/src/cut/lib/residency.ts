// Where a project lives is a fact about the project, not the link that opened
// it: the editor resolves residency by asking, so URLs stay clean. With the
// web-mode flag off everything is local (today's behavior). Otherwise the
// engine — when one is already connected; loopback is never probed here, so
// the browser's local-network ask can't fire — is asked whether it owns the
// id, and a miss means the project is cloud-resident.
//
// A project opens into one residency. The library is the other way around: it
// is the user's shelf, and both halves of it are theirs, so every surface that
// shows the library shows every residency this browser can reach — a cloud
// project can still pull a clip off this Mac's disk, and a local project can
// still pull one out of the cloud.
import { engineOrigin, servedFromEngine } from "./api";
import { cutMode } from "./backend";
import { cloudBackend } from "./backend/cloud";
import { localBackend } from "./backend/local";
import type { CutBackend, CutMode } from "./backend/types";
import { webModeEnabled } from "./flags";

/** Where a piece of the user's own data lives. ("shared" is a view of someone
 * else's cloud project, never a residency of yours, so it never lists here.) */
export type Residency = "local" | "cloud";

export const backendFor = (r: Residency): CutBackend =>
  r === "cloud" ? cloudBackend : localBackend;

export const RESIDENCY_LABEL: Record<Residency, string> = {
  local: "On this Mac",
  cloud: "Cloud",
};

/**
 * The residencies this browser can talk to right now.
 *
 * The engine counts only once it has actually answered — the ConnectGate
 * resolved its origin, or the page is served by it. Probing here could raise
 * the browser's local-network prompt, and calling the engine before the gate
 * opens would hang on its latch. The cloud counts whenever web mode is on;
 * without the flag there is no hosted half to read.
 */
export function availableResidencies(): Residency[] {
  const out: Residency[] = [];
  if (servedFromEngine() || engineOrigin() !== "") out.push("local");
  if (webModeEnabled()) out.push("cloud");
  // Neither resolved yet: fall back to whatever the app is bound to, so a
  // caller always has one backend to ask.
  if (out.length === 0) out.push(activeResidency());
  return out;
}

/** The residency the app is bound to: where a new library upload lands, and
 * where the open project lives. A shared view reads the local shelf. */
export function activeResidency(): Residency {
  return cutMode() === "cloud" ? "cloud" : "local";
}

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
