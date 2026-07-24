// Cloud mirror of a project's chat threads. Local projects keep chat purely in
// localStorage; a cloud project's threads also sync to the hosted
// /projects/:id/chats routes so the history follows the account across
// devices. Threads stay opaque here — the module reads only id and updatedAt
// to merge, and ships the same slimmed payload the panel writes to storage.
import { apiFetch, cutMode } from "./backend";
import { threadsKey } from "./chatThreads";

type ThreadRecord = { id: string; updatedAt?: number };

const isThread = (v: unknown): v is ThreadRecord =>
  !!v && typeof v === "object" && typeof (v as ThreadRecord).id === "string";

const seeded = new Map<string, Promise<void>>();

/** Merge the server's copy of a cloud project's threads into localStorage —
 * per thread, the newer updatedAt wins. Resolves immediately for local
 * projects; memoized per project, but a network failure clears the memo so
 * the next panel mount retries. */
export function ensureCloudThreads(projectId: string): Promise<void> {
  if (cutMode() !== "cloud") return Promise.resolve();
  let p = seeded.get(projectId);
  if (!p) {
    p = seedThreads(projectId).catch(() => {
      seeded.delete(projectId);
    });
    seeded.set(projectId, p);
  }
  return p;
}

async function seedThreads(projectId: string): Promise<void> {
  const res = await apiFetch(`/api/cut/projects/${projectId}/chats`);
  if (!res.ok) return;
  const remote = (await res.json()) as unknown;
  if (!Array.isArray(remote)) return;
  let local: unknown[] = [];
  try {
    const v = JSON.parse(localStorage.getItem(threadsKey(projectId)) ?? "[]") as unknown;
    if (Array.isArray(v)) local = v;
  } catch {
    // Unreadable local copy — the server copy stands alone.
  }
  const byId = new Map<string, ThreadRecord>();
  for (const t of [...remote, ...local].filter(isThread)) {
    const prev = byId.get(t.id);
    if (!prev || (t.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) byId.set(t.id, t);
  }
  const merged = [...byId.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  try {
    localStorage.setItem(threadsKey(projectId), JSON.stringify(merged));
  } catch {
    // Storage full/blocked — the in-memory panel still works this session.
  }
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

export function queueCloudThreadSave(projectId: string, thread: ThreadRecord): void {
  if (cutMode() !== "cloud") return;
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
    await apiFetch(`/api/cut/projects/${entry.projectId}/chats/${entry.threadId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry.data),
      keepalive,
    });
  } catch {
    // The thread is still in localStorage; its next change re-queues it.
  }
}

/** Push every queued save now instead of waiting out the debounce. */
export function flushCloudThreadSaves(keepalive = false): void {
  for (const key of [...pending.keys()]) void flushOne(key, keepalive);
}

/** Delete the server copy of a thread (deleted or pruned locally). */
export function deleteCloudThread(projectId: string, threadId: string): void {
  if (cutMode() !== "cloud") return;
  const entry = pending.get(saveKey(projectId, threadId));
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(saveKey(projectId, threadId));
  }
  void apiFetch(`/api/cut/projects/${projectId}/chats/${threadId}`, {
    method: "DELETE",
  }).catch(() => {
    // Offline delete — the copy resurfaces on the next merge; the user can
    // delete it again.
  });
}
