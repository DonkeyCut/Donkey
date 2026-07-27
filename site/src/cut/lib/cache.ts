"use client";

/**
 * Last-known-good snapshots of what the app re-reads on every visit: the
 * projects and library listings, a project's document, its signed media
 * links. They live in IndexedDB, so a reload paints what you saw last time
 * within a millisecond or two while the real request is still in flight.
 *
 * Everything here is a cache and never a source of truth. A miss, a quota
 * failure, or a private-mode browser costs a spinner and nothing else, so
 * every entry point swallows its errors. Keys are scoped to the signed-in
 * account and to the backend that served the data, because a second account
 * on the same Mac and a project's cloud twin must never read each other's
 * snapshots.
 */

import { currentEngineUser } from "./api";

const DB_NAME = "cut";
// v1 held only the per-project view state; v2 adds this store beside it.
const DB_VERSION = 2;
const UI_STORE = "project-ui";
const SNAPSHOT_STORE = "snapshots";

/** A snapshot older than this is dropped on read — too old to be a useful
 * head start, and old enough that painting it would be a lie. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type Entry = { at: number; value: unknown };

let db: Promise<IDBDatabase> | null = null;

/** The app's one IndexedDB handle. Shared with uiState.ts: two modules
 * opening the same database at different versions would deadlock each other. */
export function openCutDb(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const names = req.result.objectStoreNames;
      if (!names.contains(UI_STORE)) req.result.createObjectStore(UI_STORE);
      if (!names.contains(SNAPSHOT_STORE)) req.result.createObjectStore(SNAPSHOT_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  })
    .then((conn) => {
      prune(conn);
      return conn;
    })
    .catch((err) => {
      db = null; // a failed open isn't memoized; the next reader tries again
      throw err;
    });
  return db;
}

/** Sweep entries past their age, once per session on the first open, so a
 * browser that has visited a few hundred projects doesn't keep them all. */
function prune(conn: IDBDatabase) {
  try {
    const store = conn.transaction(SNAPSHOT_STORE, "readwrite").objectStore(SNAPSHOT_STORE);
    const cutoff = Date.now() - MAX_AGE_MS;
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      if ((cursor.value as Entry)?.at < cutoff) cursor.delete();
      cursor.continue();
    };
  } catch {
    // Entries past their age are ignored on read anyway.
  }
}

/** Scope a key to the signed-in account and the backend that owns the data.
 * Anything read before the session binds gets the `-` scope, which no real
 * account shares, so it simply misses. */
export const snapshotKey = (backend: string, ...parts: string[]) =>
  [currentEngineUser() ?? "-", backend, ...parts].join("/");

export async function readSnapshot<T>(key: string): Promise<{ value: T; at: number } | null> {
  try {
    const conn = await openCutDb();
    const entry = await new Promise<Entry | undefined>((resolve) => {
      const req = conn.transaction(SNAPSHOT_STORE).objectStore(SNAPSHOT_STORE).get(key);
      req.onsuccess = () => resolve(req.result as Entry | undefined);
      req.onerror = () => resolve(undefined);
    });
    if (!entry || Date.now() - entry.at > MAX_AGE_MS) return null;
    return { value: entry.value as T, at: entry.at };
  } catch {
    return null;
  }
}

/** Record a snapshot. Fire-and-forget: callers are on the happy path of a
 * request that already succeeded and have nothing to do if the write fails. */
export function writeSnapshot(key: string, value: unknown): void {
  void (async () => {
    try {
      const conn = await openCutDb();
      conn
        .transaction(SNAPSHOT_STORE, "readwrite")
        .objectStore(SNAPSHOT_STORE)
        .put({ at: Date.now(), value } satisfies Entry, key);
    } catch {
      // Best-effort; the next visit just waits on the network like before.
    }
  })();
}

export function dropSnapshot(key: string): void {
  void (async () => {
    try {
      const conn = await openCutDb();
      conn.transaction(SNAPSHOT_STORE, "readwrite").objectStore(SNAPSHOT_STORE).delete(key);
    } catch {
      // A snapshot that outlives its subject expires on its own age.
    }
  })();
}

