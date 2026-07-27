// Chat history is per project, stored in localStorage. The keys and a couple of
// raw readers live in this leaf module (importing nothing app-specific) so both
// the AI panel — which owns the history — and the generate store — which must
// refuse to resume a render whose thread the user deleted — can reach it without
// importing each other.

// The keys derive from the route's project id, never the editor store's
// projectId (that still points at the previously open project until loadProject
// lands, which used to leak one project's chat into another).
export const threadsKey = (projectId: string) => `cut-ai-threads-${projectId}`;
// The open chat survives hiding the panel — only the + button starts a new one.
export const activeChatKey = (projectId: string) => `cut-ai-active-${projectId}`;

/** A saved thread as this module handles it: an opaque record read only for its
 * id and modified time, so history, the cloud mirror, and project copies can
 * move threads around without knowing the panel's payload. */
export type StoredThread = { id: string; updatedAt?: number };

export const isStoredThread = (v: unknown): v is StoredThread =>
  !!v && typeof v === "object" && typeof (v as StoredThread).id === "string";

/** Every saved thread in a project, as stored. */
export function readProjectThreads(projectId: string): StoredThread[] {
  try {
    const v = JSON.parse(localStorage.getItem(threadsKey(projectId)) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter(isStoredThread) : [];
  } catch {
    return [];
  }
}

/** Replace a project's stored thread list. */
export function writeProjectThreads(projectId: string, threads: StoredThread[]): void {
  try {
    localStorage.setItem(threadsKey(projectId), JSON.stringify(threads));
  } catch {
    // Storage full/blocked — history just won't persist.
  }
}

/** One thread list from many, newest copy of each id winning, newest first. */
export function mergeThreads(...lists: StoredThread[][]): StoredThread[] {
  const byId = new Map<string, StoredThread>();
  for (const t of lists.flat()) {
    const prev = byId.get(t.id);
    if (!prev || (t.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) byId.set(t.id, t);
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** The ids of every saved thread in a project. The render-resume guard checks a
 * job's owning thread against this on boot: a chat render whose thread is gone
 * (deleted, or its whole project deleted, which clears these keys) is dismissed
 * rather than landed, so a reload can't resurrect media the user removed. */
export function readThreadIds(projectId: string): Set<string> {
  return new Set(readProjectThreads(projectId).map((t) => t.id));
}

/** Drop a project's chat history and active-thread pointer — called when the
 * project itself is deleted, so no stale thread or its renders survive it. */
export function clearProjectThreads(projectId: string): void {
  try {
    localStorage.removeItem(threadsKey(projectId));
    localStorage.removeItem(activeChatKey(projectId));
  } catch {
    // Storage blocked — nothing to clear.
  }
}
