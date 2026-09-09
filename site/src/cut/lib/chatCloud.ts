// Cloud mirror of a project's chat threads. Local and browser projects keep
// chat purely in localStorage; a cloud project's threads also sync to the hosted
// /projects/:id/chats routes so the history follows the account across
// devices. Threads stay opaque here — the module reads only id and updatedAt
// to merge, and ships the same slimmed payload the panel writes to storage.
import { cutMode, getBackend, type CutBackend } from "./backend";
import { cloudBackend } from "./backend/cloud";
import {
  chatThreadDeleted,
  deleteStoredThread,
  isStoredThread,
  mergeThreads,
  readProjectThreads,
  writeProjectThreads,
  type StoredThread,
} from "./chatThreads";

let syncState: {
  projectId: string;
  backend: CutBackend;
  versions: Map<string, string>;
  pending?: Promise<void>;
  seeded: boolean;
  dirty: boolean;
} | undefined;

/** A cloud project's threads as the server holds them. Takes its backend, so a
 * project copy can read the residency it is copying from rather than the one
 * the editor happens to be bound to. */
export async function fetchCloudThreads(
  backend: CutBackend,
  projectId: string
): Promise<StoredThread[]> {
  // The shared backend rewrites this path onto the viewer surface, which
  // serves the owner's threads when the share includes chat.
  if (backend.kind === "local" || backend.kind === "browser") return [];
  // Throws on a failed read rather than reading as "no threads": the seed memo
  // and a project copy both have to tell an empty history from a lost one.
  const res = await backend.fetch(`/api/cut/projects/${projectId}/chats`);
  if (!res.ok) throw new Error("Could not read the project's chats.");
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? mergeThreads(body.filter(isStoredThread)) : [];
}

/** Write one thread to a cloud project, on an explicit backend. Throws on a
 * failed write — a copy that loses a conversation has to say so. */
export async function putCloudThread(
  backend: CutBackend,
  projectId: string,
  thread: StoredThread
): Promise<void> {
  if (backend.kind !== "cloud") return;
  const res = await backend.fetch(`/api/cut/projects/${projectId}/chats/${thread.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(thread),
  });
  if (res.status === 410) { deleteStoredThread(projectId, thread.id); return; }
  if (!res.ok) throw new Error("Could not save a chat thread.");
}

/** Merge changed conversations and retry local saves, including offline deletions. */
export function ensureCloudThreads(projectId: string, refresh = false): Promise<void> {
  const backend = getBackend();
  if (backend.kind === "local" || backend.kind === "browser") return Promise.resolve();
  if (!syncState || syncState.projectId !== projectId || syncState.backend !== backend)
    syncState = { projectId, backend, versions: new Map(), seeded: false, dirty: true };
  const state = syncState;
  if (state.pending) return state.pending;
  if (state.seeded && !refresh) return Promise.resolve();
  state.pending = syncThreads(state).then(() => { state.seeded = true; }).catch(() => {
    state.seeded = false;
  }).finally(() => { state.pending = undefined; });
  return state.pending;
}

async function syncThreads(state: NonNullable<typeof syncState>): Promise<void> {
  const { projectId, backend, versions } = state;
  const path = `/api/cut/projects/${projectId}/chats`;
  const response = await backend.fetch(`${path}?revisions=1`);
  if (!response.ok) throw new Error("Could not read the project's chats.");
  const index = await response.json() as { id: string; revision: string }[];
  const remoteIds = new Set(index.map((row) => row.id));
  for (const row of index) {
    if (versions.get(row.id) === row.revision) continue;
    const res = await backend.fetch(`${path}?id=${encodeURIComponent(row.id)}&revision=${encodeURIComponent(row.revision)}`);
    if (!res.ok) throw new Error("Could not read the conversation.");
    const remote = (await res.json() as unknown[]).filter(isStoredThread);
    const local = readProjectThreads(projectId);
    const merged = mergeThreads(remote, local);
    writeProjectThreads(projectId, merged);
    const incoming = remote.find((t) => t.id === row.id);
    const outgoing = merged.find((t) => t.id === row.id);
    if (backend.kind === "cloud" && outgoing && incoming &&
        (outgoing.deleted && !incoming.deleted || !outgoing.deleted && (outgoing.updatedAt ?? 0) > (incoming.updatedAt ?? 0))) {
      await saveCloudThread(backend, projectId, outgoing);
    }
    versions.set(row.id, row.revision);
  }
  if (backend.kind === "cloud" && state.dirty) {
    for (const thread of readProjectThreads(projectId)) {
      if (!remoteIds.has(thread.id)) await saveCloudThread(backend, projectId, thread);
    }
    state.dirty = false;
  }
}

async function saveCloudThread(backend: CutBackend, projectId: string, thread: StoredThread): Promise<void> {
  if (!thread.deleted) return putCloudThread(backend, projectId, thread);
  const res = await backend.fetch(`/api/cut/projects/${projectId}/chats/${thread.id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Could not delete the conversation.");
}

// Saves debounce per thread: while a turn streams, the panel re-saves on every
// token, and each save only needs to land eventually. flush() pushes whatever
// is queued right away — on turn end and on pagehide.
const SAVE_DELAY_MS = 1500;

interface PendingSave {
  projectId: string;
  threadId: string;
  data: unknown;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingSave>();
let pageHideHooked = false;

const saveKey = (projectId: string, threadId: string) => `${projectId}/${threadId}`;

export function queueCloudThreadSave(projectId: string, thread: StoredThread): void {
  if (cutMode() !== "cloud" || chatThreadDeleted(projectId, thread.id)) return;
  if (syncState?.projectId === projectId) {
    syncState.versions.delete(thread.id);
    syncState.dirty = true;
  }
  const key = saveKey(projectId, thread.id);
  const prev = pending.get(key);
  if (prev) clearTimeout(prev.timer);
  pending.set(key, {
    projectId,
    threadId: thread.id,
    data: thread,
    timer: setTimeout(() => void flushOne(key), SAVE_DELAY_MS),
  });
  if (!pageHideHooked && typeof window !== "undefined") {
    pageHideHooked = true;
    window.addEventListener("pagehide", () => flushCloudThreadSaves(true));
  }
}

async function flushOne(key: string, keepalive = false): Promise<void> {
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  clearTimeout(entry.timer);
  try {
    // The cloud backend by name, not the ambient one: this save was queued for
    // a cloud project, and by the time the debounce fires the user may have
    // closed it — with the Mac app running, the ambient backend is then the
    // engine, which has no chats route and no copy of this project.
    const response = await cloudBackend.fetch(`/api/cut/projects/${entry.projectId}/chats/${entry.threadId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry.data),
      keepalive,
    });
    if (response.status === 410) deleteStoredThread(entry.projectId, entry.threadId);
    else if (!response.ok) throw new Error("Could not save the conversation.");
  } catch {
    if (syncState?.projectId === entry.projectId) {
      syncState.versions.delete(entry.threadId);
      syncState.dirty = true;
    }
    // The thread is still in localStorage; the next sync pushes it up.
  }
}

/** Push every queued save now instead of waiting out the debounce. */
export function flushCloudThreadSaves(keepalive = false): void {
  for (const key of [...pending.keys()]) void flushOne(key, keepalive);
}

/** Delete the server copy of a thread (deleted or pruned locally). */
export function deleteCloudThread(projectId: string, threadId: string): void {
  if (cutMode() !== "cloud") return;
  if (syncState?.projectId === projectId) {
    syncState.versions.delete(threadId);
    syncState.dirty = true;
  }
  const entry = pending.get(saveKey(projectId, threadId));
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(saveKey(projectId, threadId));
  }
  void cloudBackend.fetch(`/api/cut/projects/${projectId}/chats/${threadId}`, {
    method: "DELETE",
  }).catch(() => {
    // The durable tombstone retries on the next sync.
  });
}
