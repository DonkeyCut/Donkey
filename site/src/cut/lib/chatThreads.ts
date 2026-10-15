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
// Messages typed while a reply streams wait here, per thread.
export const queueKey = (projectId: string, threadId: string) => `cut-ai-queue-${projectId}-${threadId}`;
// Which background replies the user has seen, per project.
export const seenRepliesKey = (projectId: string) => `cut-ai-seen-replies-${projectId}`;

const changes = new Set<(projectId: string) => void>();
const notify = (projectId: string) => { for (const onChange of changes) onChange(projectId); };
export function subscribeChatThreads(projectId: string, onChange: () => void): () => void {
  const local = (id: string) => { if (id === projectId) onChange(); };
  // Without a thread store, other tabs' writes arrive as storage events; with
  // one, over the broadcast channel (which lands in `changes`).
  const remote = (event: StorageEvent) => {
    if (event.key === threadsKey(projectId)) onChange();
  };
  changes.add(local);
  listenAcrossTabs();
  window.addEventListener("storage", remote);
  return () => { changes.delete(local); window.removeEventListener("storage", remote); };
}

// Where the threads live. An owner's are durable in this browser; a shared
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
export type StoredThread = { id: string; updatedAt?: number; deleted?: boolean };

export const isStoredThread = (v: unknown): v is StoredThread =>
  !!v && typeof v === "object" && typeof (v as StoredThread).id === "string";

/** Durable thread lists, one per project. IndexedDB in the browser: a long
 * agent turn's history runs to megabytes, and localStorage's 5 MB per origin
 * — shared by every project and every other key — filled up and silently
 * dropped every save after. */
export interface ThreadStore {
  read(projectId: string): Promise<unknown[] | undefined>;
  /** Rejects when the browser refuses the write (QuotaExceededError when full). */
  write(projectId: string, list: unknown[]): Promise<void>;
  remove(projectId: string): Promise<void>;
  projects(): Promise<string[]>;
  /** How full the origin's storage is, 0–1, when the browser says. */
  pressure(): Promise<number | undefined>;
}

async function chatStore<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  // Loaded on first use, so this module stays a leaf the generate store and
  // the server-free tests can import.
  const { openCutDb, CHAT_STORE } = await import("./cache");
  const conn = await openCutDb();
  return new Promise<T>((resolve, reject) => {
    const tx = conn.transaction(CHAT_STORE, mode);
    const req = op(tx.objectStore(CHAT_STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? req.error ?? new Error("chat store transaction failed"));
  });
}

const indexedDbStore: ThreadStore = {
  read: (projectId) => chatStore("readonly", (s) => s.get(projectId)).then((v) => (Array.isArray(v) ? v : undefined)),
  write: (projectId, list) => chatStore("readwrite", (s) => s.put(list, projectId)).then(() => undefined),
  remove: (projectId) => chatStore("readwrite", (s) => s.delete(projectId)).then(() => undefined),
  projects: () => chatStore("readonly", (s) => s.getAllKeys()).then((keys) => keys.map(String)),
  pressure: async () => {
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    return estimate?.quota ? (estimate.usage ?? 0) / estimate.quota : undefined;
  },
};

// The thread store in use: undefined until first needed, null when there is
// none and history falls back to localStorage (no IndexedDB, or it failed).
let backing: ThreadStore | null | undefined;
function threadStore(): ThreadStore | null {
  if (backing === undefined) backing = typeof indexedDB === "undefined" ? null : indexedDbStore;
  return backing;
}

// Each loaded project's list, so the panel reads synchronously; writes land
// here first and reach the store in the background.
const cache = new Map<string, unknown[]>();
const loads = new Map<string, Promise<void>>();
const loaded = new Set<string>();
const dirty = new Set<string>();
let migration: Promise<void> | null = null;
let queue: Promise<void> = Promise.resolve();
let flushScheduled = false;
const persistedSize = new Map<string, number>();
// How long a load waits on the store (another tab can hold the database on an
// older version) before this tab falls back to localStorage.
const LOAD_TIMEOUT_MS = 5000;

/** Swap the thread store — tests, and the fallback when IndexedDB fails. Null
 * means localStorage. Resets everything held in memory. */
export function useThreadStore(store: ThreadStore | null): void {
  backing = store;
  cache.clear();
  loads.clear();
  loaded.clear();
  dirty.clear();
  persistedSize.clear();
  migration = null;
  queue = Promise.resolve();
  flushScheduled = false;
  goneChecked.clear();
  setSaveFailure(null);
}

const legacyPrefix = threadsKey("");
function readLegacy(projectId: string): unknown[] {
  try {
    const v = JSON.parse(localStorage.getItem(threadsKey(projectId)) ?? "[]") as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const merged = (...lists: unknown[][]) => mergeThreads(...lists.map((l) => l.filter(isStoredThread)));
const sizeOf = (list: unknown[]) => JSON.stringify(list).length;

/** Move every project's localStorage history into the store, once per page,
 * then free the keys. A key whose write fails stays put for the next try. */
function migrateLegacyThreads(store: ThreadStore): Promise<void> {
  migration ??= (async () => {
    let keys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(legacyPrefix)) keys.push(key);
      }
    } catch {
      keys = [];
    }
    for (const key of keys) {
      const projectId = key.slice(legacyPrefix.length);
      const legacy = readLegacy(projectId);
      try {
        const stored = (await store.read(projectId)) ?? [];
        await store.write(projectId, merged(stored, legacy));
        // A page that fell back to localStorage meanwhile still reads the key.
        if (backing === store) localStorage.removeItem(key);
      } catch (err) {
        console.warn(`[chat] couldn't move project ${projectId}'s chat history out of localStorage`, err);
      }
    }
  })();
  return migration;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`chat store didn't answer in ${ms}ms`)), ms);
    work.then((v) => { clearTimeout(timer); resolve(v); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Read a project's history from the store into memory, once. The panel waits
 * on this before showing threads, so it never flashes an empty history. */
export function loadProjectThreads(projectId: string): Promise<void> {
  const store = threadStore();
  if (memory || !store || loaded.has(projectId)) return Promise.resolve();
  let load = loads.get(projectId);
  if (!load) {
    load = withTimeout(
      (async () => {
        await migrateLegacyThreads(store);
        const stored = (await store.read(projectId)) ?? [];
        if (backing !== store) return;
        persistedSize.set(projectId, sizeOf(stored));
        // Anything written before the load finished joins what was stored, as
        // does a localStorage copy the migration couldn't move.
        const early = [...readLegacy(projectId), ...(cache.get(projectId) ?? [])];
        cache.set(projectId, early.length ? merged(stored, early) : stored);
        loaded.add(projectId);
        if (early.length) schedule(projectId);
        notify(projectId);
      })(),
      LOAD_TIMEOUT_MS,
    ).catch((err) => {
      if (backing !== store) return;
      console.warn("[chat] chat history store unavailable; using localStorage for this page", err);
      const early = [...cache];
      useThreadStore(null);
      for (const [id, list] of early) writeRawThreads(id, merged(readLegacy(id), list));
    });
    loads.set(projectId, load);
  }
  return load;
}

/** Whether a project's history has been read, so an empty list means none. */
export function threadsLoaded(projectId: string): boolean {
  return !!memory || !threadStore() || loaded.has(projectId);
}

/** A project's thread list exactly as written. The AI panel owns the payload;
 * this module owns where it lives. */
export function readRawThreads(projectId: string): unknown[] {
  if (memory) return memory.threads.get(projectId) ?? [];
  // Before its load lands, a project shows whatever localStorage still holds.
  return cache.get(projectId) ?? readLegacy(projectId);
}

/** Replace a project's thread list, payload untouched. */
export function writeRawThreads(projectId: string, list: unknown[]): void {
  // Deletion wins over callbacks and remote copies still holding the old thread.
  const deleted = readRawThreads(projectId).filter(isStoredThread).filter((t) => t.deleted);
  if (deleted.length) list = mergeThreads(list.filter(isStoredThread), deleted);
  if (memory) {
    memory.threads.set(projectId, list);
    notify(projectId);
    return;
  }
  if (!threadStore()) {
    try {
      localStorage.setItem(threadsKey(projectId), JSON.stringify(list));
      setSaveFailure(null);
    } catch (err) {
      saveFailed(err);
    }
    notify(projectId);
    return;
  }
  cache.set(projectId, list);
  notify(projectId);
  schedule(projectId);
}

/** Run store work in order: a removal never races a save of the same project. */
function enqueue(work: () => Promise<void>): Promise<void> {
  queue = queue.then(work, work);
  return queue;
}

function schedule(projectId: string): void {
  dirty.add(projectId);
  if (flushScheduled) return;
  flushScheduled = true;
  // A burst of writes (a streaming reply, a cloud merge) persists once.
  queueMicrotask(() => {
    flushScheduled = false;
    void enqueue(persistDirty);
  });
}

async function persistDirty(): Promise<void> {
  const store = backing;
  if (!store) return;
  for (const projectId of [...dirty]) {
    // A save waits for the project's load, which merges it with what was
    // stored rather than overwriting history this page never read.
    if (!loaded.has(projectId)) await loadProjectThreads(projectId);
    if (backing !== store || !dirty.has(projectId) || !loaded.has(projectId)) continue;
    const list = cache.get(projectId);
    if (!list) continue;
    dirty.delete(projectId);
    await persist(store, projectId, list);
  }
}

const isQuotaError = (err: unknown) =>
  !!err && typeof err === "object" && ((err as Error).name === "QuotaExceededError" || (err as { code?: number }).code === 22);

async function persist(store: ThreadStore, projectId: string, list: unknown[]): Promise<void> {
  const size = sizeOf(list);
  const growth = size - (persistedSize.get(projectId) ?? 0);
  try {
    const pressure = await store.pressure().catch(() => undefined);
    if (pressure !== undefined && pressure > PRESSURE) await makeRoom(store, projectId, growth);
    for (let attempt = 0; ; attempt++) {
      try {
        await store.write(projectId, list);
        break;
      } catch (err) {
        // The browser doesn't say how far over it is: free what this save
        // adds, then twice that, and so on.
        if (!isQuotaError(err) || attempt >= 4) throw err;
        if ((await makeRoom(store, projectId, Math.max(growth, 1024) * 2 ** attempt)) === 0) throw err;
      }
    }
    persistedSize.set(projectId, size);
    removeLocal(threadsKey(projectId));
    setSaveFailure(null);
    broadcast(projectId);
  } catch (err) {
    saveFailed(err);
  }
}

/** Above this share of the origin's quota, a save first clears room. */
const PRESSURE = 0.9;

/** Free at least `bytes` by dropping the oldest threads of other projects —
 * the open project's history is the last thing to lose. Returns the bytes freed. */
async function makeRoom(store: ThreadStore, keep: string, bytes: number): Promise<number> {
  if (bytes <= 0) return 0;
  const lists = new Map<string, unknown[]>();
  for (const projectId of await store.projects()) {
    if (projectId === keep) continue;
    lists.set(projectId, (loaded.has(projectId) ? cache.get(projectId) : await store.read(projectId)) ?? []);
  }
  const candidates = [...lists].flatMap(([projectId, list]) =>
    list.filter(isStoredThread).filter((t) => !t.deleted).map((thread) => ({ projectId, thread })),
  );
  candidates.sort((a, b) => (a.thread.updatedAt ?? 0) - (b.thread.updatedAt ?? 0));
  let freed = 0;
  const dropped = new Map<string, Set<string>>();
  for (const { projectId, thread } of candidates) {
    if (freed >= bytes) break;
    freed += JSON.stringify(thread).length;
    if (!dropped.has(projectId)) dropped.set(projectId, new Set());
    dropped.get(projectId)!.add(thread.id);
  }
  for (const [projectId, ids] of dropped) {
    const rest = lists.get(projectId)!.filter((t) => !isStoredThread(t) || !ids.has(t.id));
    if (rest.some((t) => isStoredThread(t) && !t.deleted)) await store.write(projectId, rest);
    else await store.remove(projectId);
    persistedSize.set(projectId, sizeOf(rest));
    if (cache.has(projectId)) cache.set(projectId, rest);
    for (const id of ids) removeLocal(queueKey(projectId, id));
    notify(projectId);
    broadcast(projectId);
  }
  const count = [...dropped.values()].reduce((n, ids) => n + ids.size, 0);
  if (count) console.warn(`[chat] browser storage nearly full; dropped the ${count} oldest chat thread(s) of other projects`);
  return freed;
}

/** Wait until every write so far has reached the store. */
export async function flushThreadSaves(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await queue;
    await Promise.all(loads.values());
    if (!dirty.size || !backing) return;
    await enqueue(persistDirty);
  }
}

// A failed save is told once in the console and shown in the panel until a
// save lands again.
let saveFailure: string | null = null;
let warned = false;
const failureChanges = new Set<() => void>();
function setSaveFailure(message: string | null): void {
  if (message === saveFailure) return;
  saveFailure = message;
  for (const onChange of failureChanges) onChange();
}
function saveFailed(err: unknown): void {
  if (!warned) {
    warned = true;
    console.warn("[chat] couldn't save chat history in this browser", err);
  }
  setSaveFailure(
    isQuotaError(err)
      ? "Chat history couldn't be saved — this browser's storage is full."
      : "Chat history couldn't be saved in this browser.",
  );
}
export function threadSaveFailure(): string | null {
  return saveFailure;
}
export function subscribeThreadSaveFailure(onChange: () => void): () => void {
  failureChanges.add(onChange);
  return () => failureChanges.delete(onChange);
}

// Other tabs of this browser hear about saves to reread them.
let channel: BroadcastChannel | null | undefined;
function crossTab(): BroadcastChannel | null {
  if (channel === undefined) channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("cut-ai-threads");
  return channel;
}
function broadcast(projectId: string): void {
  try {
    crossTab()?.postMessage({ projectId });
  } catch {
    // A closed channel only costs other tabs a stale list until reload.
  }
}
let listening = false;
function listenAcrossTabs(): void {
  const ch = crossTab();
  if (listening || !ch) return;
  listening = true;
  ch.addEventListener("message", (event: MessageEvent<{ projectId?: unknown }>) => {
    const projectId = event.data?.projectId;
    const store = backing;
    if (typeof projectId !== "string" || !store || !cache.has(projectId) || dirty.has(projectId)) return;
    void store.read(projectId).then((list) => {
      if (backing !== store || dirty.has(projectId)) return;
      cache.set(projectId, list ?? []);
      persistedSize.set(projectId, sizeOf(list ?? []));
      notify(projectId);
    }, () => {});
  });
}

function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage blocked — nothing to clear.
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
    if (!prev || t.deleted || (!prev.deleted && (t.updatedAt ?? 0) >= (prev.updatedAt ?? 0))) byId.set(t.id, t);
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** The ids of every saved thread in a project. The render-resume guard checks a
 * job's owning thread against this on boot: a chat render whose thread is gone
 * (deleted, or its whole project deleted, which clears these keys) is dismissed
 * rather than landed, so a reload can't resurrect media the user removed. */
export function readThreadIds(projectId: string): Set<string> {
  return new Set(readProjectThreads(projectId).filter((t) => !t.deleted).map((t) => t.id));
}

/** Drop everything a project's chat left in this browser — its threads, open
 * chat, queued messages and read marks — when the project itself is deleted,
 * so no stale thread or its renders survive it. */
export function clearProjectThreads(projectId: string): void {
  if (memory) {
    memory.threads.delete(projectId);
    memory.active.delete(projectId);
    return;
  }
  const store = threadStore();
  if (store) {
    cache.set(projectId, []);
    loaded.add(projectId);
    dirty.delete(projectId);
    persistedSize.delete(projectId);
    void enqueue(async () => {
      try {
        await store.remove(projectId);
        broadcast(projectId);
      } catch {
        // The sweep of gone projects retries on a later visit.
      }
    });
  }
  const queued = queueKey(projectId, "");
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(queued)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Storage blocked — nothing to clear.
  }
  removeLocal(threadsKey(projectId));
  removeLocal(activeChatKey(projectId));
  removeLocal(seenRepliesKey(projectId));
  notify(projectId);
}

// Projects already asked about this page: a listing refetch doesn't re-ask.
const goneChecked = new Set<string>();

/** Clear the history of projects this browser holds threads for but no
 * listing shows, once `gone` confirms each is deleted (not merely on a
 * backend this page can't reach right now). */
export async function sweepGoneProjectThreads(listed: Set<string>, gone: (projectId: string) => Promise<boolean>): Promise<void> {
  if (memory) return;
  const store = threadStore();
  let held: string[] = [];
  try {
    if (store) {
      await migrateLegacyThreads(store);
      held = await store.projects();
    } else {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(legacyPrefix)) held.push(key.slice(legacyPrefix.length));
      }
    }
  } catch {
    return;
  }
  for (const projectId of held) {
    if (listed.has(projectId) || goneChecked.has(projectId)) continue;
    goneChecked.add(projectId);
    if (await gone(projectId).catch(() => false)) clearProjectThreads(projectId);
  }
  await flushThreadSaves();
}

export function chatThreadDeleted(projectId: string, threadId: string): boolean {
  return readProjectThreads(projectId).some((t) => t.id === threadId && t.deleted === true);
}

export function deleteStoredThread(projectId: string, threadId: string): void {
  const threads = readProjectThreads(projectId).filter((t) => t.id !== threadId);
  writeProjectThreads(projectId, [{ id: threadId, updatedAt: Date.now(), deleted: true }, ...threads]);
}

/** The live state of one chat as the AI SDK's Chat holds it: its messages and
 * the change callback its own React hook subscribes through. */
export interface ChatSource<M> {
  readonly messages: M[];
  "~registerMessagesCallback": (onChange: () => void) => () => void;
}

export interface ThreadRecorder {
  /** Save now if a change is waiting. */
  flush: () => void;
  /** Apply a change that came from storage without saving it back. */
  quietly: (apply: () => void) => void;
  /** Stop following, saving whatever is still waiting. */
  stop: () => void;
}

/** Keep a thread's stored copy following its chat. Saves hang off the chat's
 * own state rather than the panel's renders: a tab that cannot paint (the
 * screen locked, the window minimised, the tab behind another) may commit no
 * render for minutes while its stream and tools keep running, and every part
 * that arrives meanwhile still lands. A change arms one save, which reads the
 * chat as it stands when it fires, so a save never writes an older copy than
 * the chat holds. */
export function recordThread<M>(chat: ChatSource<M>, save: (messages: M[]) => void, waitMs: number): ThreadRecorder {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let quiet = false;
  const land = () => {
    timer = null;
    save(chat.messages);
  };
  const unsubscribe = chat["~registerMessagesCallback"](() => {
    if (!quiet && timer === null) timer = setTimeout(land, waitMs);
  });
  const flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    land();
  };
  return {
    flush,
    quietly: (apply) => {
      quiet = true;
      try { apply(); } finally { quiet = false; }
    },
    stop: () => {
      unsubscribe();
      flush();
    },
  };
}
