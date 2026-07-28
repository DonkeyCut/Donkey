// Cloud mirror of a project's chat threads. Local projects keep chat purely in
// localStorage; a cloud project's threads also sync to the hosted
// /projects/:id/chats routes so the history follows the account across
// devices. Threads stay opaque here — the module reads only id and updatedAt
// to merge, and ships the same slimmed payload the panel writes to storage.
import { cutMode, getBackend, type CutBackend } from "./backend";
import { cloudBackend } from "./backend/cloud";
import {
  isStoredThread,
  mergeThreads,
  readProjectThreads,
  writeProjectThreads,
  type StoredThread,
} from "./chatThreads";

const seeded = new Map<string, Promise<void>>();

/** A cloud project's threads as the server holds them. Takes its backend, so a
 * project copy can read the residency it is copying from rather than the one
 * the editor happens to be bound to. */
export async function fetchCloudThreads(
  backend: CutBackend,
  projectId: string
): Promise<StoredThread[]> {
  // The shared backend rewrites this path onto the viewer surface, which
  // serves the owner's threads when the share includes chat.
  if (backend.kind === "local") return [];
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
  if (!res.ok) throw new Error("Could not save a chat thread.");
}

/** Bring a cloud project's chat history and the server's copy into agreement,
 * per thread the newer updatedAt winning, and push back whatever the server is
 * missing or trailing on. The push is what makes the mirror hold: a save that
 * never landed — offline, a request that failed, a thread written before this
 * project moved to the cloud — would otherwise stay local forever, and a share
 * link would show a project with no chat at all. Resolves immediately for local
 * projects; memoized per project, but a failure clears the memo so the next
 * panel mount retries. */
export function ensureCloudThreads(projectId: string): Promise<void> {
  // Shared viewers sync too, read-only: syncThreads pushes nothing back, and
  // the saves and deletes below are cloud-only.
  if (cutMode() === "local") return Promise.resolve();
  let p = seeded.get(projectId);
  if (!p) {
    p = syncThreads(projectId).catch(() => {
      seeded.delete(projectId);
    });
    seeded.set(projectId, p);
  }
  return p;
}

async function syncThreads(projectId: string): Promise<void> {
  const backend = getBackend();
  const remote = await fetchCloudThreads(backend, projectId);
  // A viewer's list is the owner's list — there is nothing of their own to
  // merge, so the share's threads stand alone (in memory, per chatThreads).
  if (backend.kind === "shared") {
    writeProjectThreads(projectId, remote);
    return;
  }
  const merged = mergeThreads(remote, readProjectThreads(projectId));
  writeProjectThreads(projectId, merged);
  const stored = new Map(remote.map((t) => [t.id, t.updatedAt ?? 0]));
  const behind = merged.filter((t) => (stored.get(t.id) ?? -1) < (t.updatedAt ?? 0));
  // One at a time: a full history can be a few megabytes of transcript.
  for (const thread of behind) await putCloudThread(backend, projectId, thread);
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
    // The cloud backend by name, not the ambient one: this save was queued for
    // a cloud project, and by the time the debounce fires the user may have
    // closed it — with the Mac app running, the ambient backend is then the
    // engine, which has no chats route and no copy of this project.
    await cloudBackend.fetch(`/api/cut/projects/${entry.projectId}/chats/${entry.threadId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry.data),
      keepalive,
    });
  } catch {
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
  const entry = pending.get(saveKey(projectId, threadId));
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(saveKey(projectId, threadId));
  }
  void cloudBackend.fetch(`/api/cut/projects/${projectId}/chats/${threadId}`, {
    method: "DELETE",
  }).catch(() => {
    // Offline delete — the copy resurfaces on the next merge; the user can
    // delete it again.
  });
}
