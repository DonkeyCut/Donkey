// Where a project lives is a fact about the project, not the link that opened
// it: the editor resolves residency by asking, so URLs stay clean. The engine
// — when one is already connected; loopback is never probed here, so the
// browser's local-network ask can't fire — is asked whether it owns the id,
// and a miss means the project is cloud-resident. With no engine connected
// there is nothing to ask, so the listing this browser last stored answers
// instead: a project it saw on this Mac stays a local project, one the Donkey
// app has to come back for.
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
import { readSnapshot, snapshotKey } from "./cache";
import type { ProjectSummary } from "./types";

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
 * The cloud is always one of them — a signed-in account always has a hosted
 * shelf. The engine counts only once it has actually answered — the
 * ConnectGate resolved its origin, or the page is served by it. Probing here
 * could raise the browser's local-network prompt, and calling the engine
 * before the gate opens would hang on its latch.
 */
export function availableResidencies(): Residency[] {
  const out: Residency[] = [];
  if (servedFromEngine() || engineOrigin() !== "") out.push("local");
  out.push("cloud");
  return out;
}

/** Set the first time an engine answers in this browser (by the ConnectGate).
 * It separates a browser that never had the Donkey app from one whose app
 * isn't running — the second has projects on this Mac and the first doesn't. */
const SEEN_KEY = "cut-engine-seen";

export function engineSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markEngineSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Private mode: this browser re-learns the answer on every visit.
  }
}

/** Where a residency's last listing is stored, so the shelf survives the
 * backend that served it going away. The library keys per shelf as well as by
 * the merged set, because the halves have to be remembered separately: the
 * cloud's is re-read while the Mac's is recalled. */
export const projectsSnapshotKey = (r: Residency) => snapshotKey(r, "projects");
export const libraryShelfKey = (r: Residency) => snapshotKey(r, "library", "shelf");

/**
 * The residencies the projects home lists.
 *
 * Closing the Donkey app doesn't delete the projects on this Mac, so the shelf
 * doesn't vanish with it: a browser that has reached an engine here lists that
 * shelf from the listing it stored, whether or not the app is answering now.
 * The cards are read-only until it is, and opening one says where the project
 * lives instead of guessing at the cloud.
 */
export function listedResidencies(): Residency[] {
  const live = availableResidencies();
  if (live.includes("local") || !engineSeen()) return live;
  return ["local", ...live];
}

/** The projects this browser last saw on this Mac. Read when the engine can't
 * be asked: the listing it can't fetch is the one it already stored. */
async function lastLocalProjects(): Promise<Set<string>> {
  const hit = await readSnapshot<{ projects: ProjectSummary[] }>(projectsSnapshotKey("local"));
  return new Set((hit?.value.projects ?? []).map((p) => p.id));
}

/** The residency the app is bound to: where a new library upload lands, and
 * where the open project lives. A shared view reads the local shelf. */
export function activeResidency(): Residency {
  return cutMode() === "cloud" ? "cloud" : "local";
}

const owners = new Map<string, Promise<CutBackend>>();

/** The backend that holds a project's data, by id. Background work — a scene
 * run that outlives the editor it started in — must address the project
 * through this rather than the ambient backend: once the user navigates away
 * the ambient one is whatever the app fell back to, and a cloud project's doc
 * does not exist on the engine. A project never changes residency in place
 * (a copy gets a new id), so the answer is remembered — but only a positive
 * engine hit is definitive, since "cloud" is also what a momentarily
 * unreachable engine looks like. */
export function projectBackend(projectId: string): Promise<CutBackend> {
  let p = owners.get(projectId);
  if (!p) {
    p = resolveProjectMode(projectId).then((mode) => {
      if (mode !== "local") owners.delete(projectId);
      return backendFor(mode === "local" ? "local" : "cloud");
    });
    owners.set(projectId, p);
  }
  return p;
}

/** Where a project lives, and whether that place is answering. A project on
 * this Mac with the app closed is `{ mode: "local", reachable: false }`: it
 * exists, it is the user's, and nothing can open it until the app is back. */
export type ProjectPlacement = { mode: CutMode; reachable: boolean };

/** Ids a reachable engine answered 404 for. That answer is definitive — the
 * engine knows its own inventory and a project never changes residency in
 * place — so it is asked once per id per page load rather than on every
 * open and every background job. An engine that couldn't be reached settles
 * nothing and stays out of this set. */
const knownCloud = new Set<string>();

export async function resolveProjectPlacement(projectId: string): Promise<ProjectPlacement> {
  if (knownCloud.has(projectId)) return { mode: "cloud", reachable: true };
  if (!servedFromEngine() && !engineOrigin()) {
    // No engine to ask. A project this browser last saw on this Mac is still
    // that project — saying "cloud" would send the editor to fetch a document
    // that was never there and call it deleted.
    if (engineSeen() && (await lastLocalProjects()).has(projectId)) {
      return { mode: "local", reachable: false };
    }
    return { mode: "cloud", reachable: true };
  }
  try {
    // HEAD: the question is whether the engine owns the id, and the answer is
    // the status. The doc itself is fetched a moment later by the load.
    const res = await localBackend.fetch(`/api/cut/projects/${projectId}`, { method: "HEAD" });
    if (res.ok) return { mode: "local", reachable: true };
    if (res.status === 404) knownCloud.add(projectId);
  } catch {
    // The engine dropped since the gate probed it; the cloud copy (if any)
    // is the only reachable one.
  }
  return { mode: "cloud", reachable: true };
}

export async function resolveProjectMode(projectId: string): Promise<CutMode> {
  return (await resolveProjectPlacement(projectId)).mode;
}
