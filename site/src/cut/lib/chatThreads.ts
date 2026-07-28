// Chat history is per project. The keys and a couple of raw readers live in
// this leaf module (importing nothing app-specific) so both the AI panel —
// which owns the history — and the generate store — which must refuse to
// resume a render whose thread the user deleted — can reach it without
// importing each other.

// The keys derive from the route's project id, never the editor store's
// projectId (that still points at the previously open project until loadProject
// lands, which used to leak one project's chat into another).
export const threadsKey = (projectId: string) => `cut-ai-threads-${projectId}`;
// The open chat survives hiding the panel — only the + button starts a new one.
export const activeChatKey = (projectId: string) => `cut-ai-active-${projectId}`;

// Where the threads live. An owner's are durable in localStorage; a shared
// viewer holds the owner's copy in memory for the tab, so reading someone
// else's project leaves nothing in this browser — and an owner opening their
// own share link keeps their stored history untouched.
let memory: { threads: Map<string, unknown[]>; active: Map<string, string> } | null = null;

/** Bound by the shared viewer page before the editor mounts. */
export function holdThreadsInMemory(): void {
  memory ??= { threads: new Map(), active: new Map() };
}

/** A saved thread as this module handles it: an opaque record read only for its
 * id and modified time, so history, the cloud mirror, and project copies can
 * move threads around without knowing the panel's payload. */
export type StoredThread = { id: string; updatedAt?: number };

export const isStoredThread = (v: unknown): v is StoredThread =>
  !!v && typeof v === "object" && typeof (v as StoredThread).id === "string";

/** A project's thread list exactly as written. The AI panel owns the payload;
 * this module owns where it lives. */
export function readRawThreads(projectId: string): unknown[] {
  if (memory) return memory.threads.get(projectId) ?? [];
  try {
    const v = JSON.parse(localStorage.getItem(threadsKey(projectId)) ?? "[]") as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Replace a project's thread list, payload untouched. */
export function writeRawThreads(projectId: string, list: unknown[]): void {
  if (memory) {
    memory.threads.set(projectId, list);
    return;
  }
  try {
    localStorage.setItem(threadsKey(projectId), JSON.stringify(list));
  } catch {
    // Storage full/blocked — history just won't persist.
  }
}

/** Every saved thread in a project, as stored. */
export function readProjectThreads(projectId: string): StoredThread[] {
  return readRawThreads(projectId).filter(isStoredThread);
}

/** Replace a project's stored thread list. */
export function writeProjectThreads(projectId: string, threads: StoredThread[]): void {
  writeRawThreads(projectId, threads);
}

/** The chat the panel reopens on, per project. */
export function readActiveChat(projectId: string): string | null {
  if (memory) return memory.active.get(projectId) ?? null;
  try {
    return localStorage.getItem(activeChatKey(projectId));
  } catch {
    return null;
  }
}

export function writeActiveChat(projectId: string, threadId: string): void {
  if (memory) {
    memory.active.set(projectId, threadId);
    return;
  }
  try {
    localStorage.setItem(activeChatKey(projectId), threadId);
  } catch {
    // Storage full/blocked — the open chat just won't be remembered.
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
  if (memory) {
    memory.threads.delete(projectId);
    memory.active.delete(projectId);
    return;
  }
  try {
    localStorage.removeItem(threadsKey(projectId));
    localStorage.removeItem(activeChatKey(projectId));
  } catch {
    // Storage blocked — nothing to clear.
  }
}
