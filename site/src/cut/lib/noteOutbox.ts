"use client";

/**
 * Note edits are saved in this browser first and synced to the cloud after.
 *
 * Every edit lands in localStorage at once, synchronously, stamped with the
 * moment it was made. A flush sends what is pending, and an entry leaves the
 * outbox only once the server has answered for it. A failed send stays
 * pending and is retried with backoff; the page also flushes when it comes
 * back online, when the session confirms its account, and as a keepalive
 * request when it is hidden (useNoteOutboxSync). Anything those miss syncs
 * the next time the notes are listed.
 *
 * The stamp is the edit's own, so a write that syncs late still loses to a
 * newer edit from the phone: the server keeps whichever stamp is newer.
 * Entries are kept per account and sent only for the confirmed account, so
 * two people sharing a browser never write each other's notes. A process with
 * no account bound — the cloud worker, whose transport carries the user —
 * keeps no outbox: its writes go straight to the server and fail when the
 * server does.
 */

import { confirmedEngineUser, currentEngineUser } from "./api";
import type { NoteLocation } from "./noteReference";
import { backendFor } from "./residency";
import type { CutNote } from "./notes";

/** One note as a write sends it. */
export interface NoteWrite {
  libraryLocation?: NoteLocation | null;
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  folderId: string | null;
  labelIds: string[];
}

interface Pending {
  note: NoteWrite;
  updatedAt: number;
}

/** How a send goes out: "unloading" rides a keepalive request so it can
 * outlive a closing page. */
export type SendMode = "now" | "unloading";

const OUTBOX_PREFIX = "cut:note-outbox:";

/** Waits between retries of a send the server did not take, longest last. */
const RETRY_MS = [2_000, 10_000, 30_000, 120_000];

/** A keepalive request carries at most 64 KB. */
const KEEPALIVE_MAX_BYTES = 60_000;

// Answers that mean the write may land later: signed out, a timeout, a rate
// limit, or the server failing. Any other refusal is the write itself.
const HTTP_UNAUTHORIZED = 401;
const HTTP_TIMEOUT = 408;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;
const retryable = (status: number) =>
  status === HTTP_UNAUTHORIZED || status === HTTP_TIMEOUT || status === HTTP_TOO_MANY || status >= HTTP_SERVER_ERROR;

// One key per note, so a keystroke rewrites only the note being typed.
const keyOf = (account: string, id: string) => `${OUTBOX_PREFIX}${account}:${id}`;

// Entries whose storage write failed — storage full or blocked — held for
// this session. A held entry is newer than whatever storage still has.
const memory = new Map<string, Pending>();

function readPending(account: string, id: string): Pending | undefined {
  const key = keyOf(account, id);
  const held = memory.get(key);
  if (held) {
    return held;
  }
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Pending) : undefined;
  } catch {
    return undefined;
  }
}

function writePending(account: string, id: string, pending: Pending | null): void {
  const key = keyOf(account, id);
  memory.delete(key);
  try {
    if (pending) {
      localStorage.setItem(key, JSON.stringify(pending));
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    if (pending) {
      memory.set(key, pending);
    }
  }
}

function pendingIds(account: string): string[] {
  const prefix = `${OUTBOX_PREFIX}${account}:`;
  const keys = new Set([...memory.keys()].filter((k) => k.startsWith(prefix)));
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) {
        keys.add(key);
      }
    }
  } catch {
    // Blocked storage lists the held entries alone.
  }
  return [...keys].map((k) => k.slice(prefix.length));
}

/** A pending write as the list shows it until the server answers. */
const localNote = (p: Pending, over?: CutNote): CutNote => ({
  libraryLocation: over?.libraryLocation ?? null,
  ...p.note,
  updatedAt: p.updatedAt,
  deletedAt: null,
  createdAt: over?.createdAt ?? p.updatedAt,
});

/** Save a note's current content in this browser, stamped now. False when no
 * account is bound, so there is no outbox to hold it. */
export function stageNote(note: NoteWrite): boolean {
  const account = currentEngineUser();
  if (!account) {
    return false;
  }
  writePending(account, note.id, { note, updatedAt: Date.now() });
  return true;
}

/** Forget a note's pending write: the note was deleted. */
export function dropPendingNote(id: string): void {
  const account = currentEngineUser();
  if (account) {
    writePending(account, id, null);
  }
}

/** The server's list with this browser's pending writes laid over it. A
 * pending write the server already holds, or holds something newer than,
 * leaves the outbox here. */
export function withPendingNotes(serverNotes: CutNote[]): CutNote[] {
  const account = currentEngineUser();
  const ids = account ? pendingIds(account) : [];
  if (!account || ids.length === 0) {
    return serverNotes;
  }

  // Lay each pending write over the server's copy, or drop it when the
  // server's copy is as new: e.g. an edit sent by keepalive as the tab closed.
  const byId = new Map(serverNotes.map((n) => [n.id, n]));
  let left = 0;
  for (const id of ids) {
    const pending = readPending(account, id);
    if (!pending) {
      continue;
    }
    const server = byId.get(id);
    if (server && server.updatedAt >= pending.updatedAt) {
      writePending(account, id, null);
      continue;
    }
    byId.set(id, localNote(pending, server));
    left++;
  }
  if (left > 0) {
    void flushNoteOutbox();
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

type Sent = { kind: "landed"; note: CutNote } | { kind: "held" } | { kind: "refused" };

async function send(note: NoteWrite, updatedAt: number, mode: SendMode): Promise<Sent> {
  const body = JSON.stringify({ ...note, updatedAt });
  const res = await backendFor("cloud")
    .fetch(`/api/cut/notes/${encodeURIComponent(note.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: mode === "unloading" && body.length < KEEPALIVE_MAX_BYTES,
    })
    .catch(() => null);
  if (!res) {
    return { kind: "held" };
  }
  if (res.ok) {
    return { kind: "landed", note: (await res.json()) as CutNote };
  }
  return retryable(res.status) ? { kind: "held" } : { kind: "refused" };
}

/** Write a note with no outbox behind it: the server's answer, or an error. */
export async function sendNoteNow(note: NoteWrite): Promise<CutNote> {
  const sent = await send(note, Date.now(), "now");
  if (sent.kind !== "landed") {
    throw new Error("Could not save the note.");
  }
  return sent.note;
}

/** Send one note's pending write. Answers with the version the server kept,
 * or with the pending write itself while it waits to sync. A write the server
 * refuses outright leaves the outbox and throws. */
export async function flushNote(id: string, mode: SendMode = "now"): Promise<CutNote | null> {
  const account = currentEngineUser();
  const pending = account ? readPending(account, id) : undefined;
  if (!account || !pending) {
    return null;
  }
  // Sent once the live session confirms this is still the account signed in.
  if (account !== confirmedEngineUser()) {
    return localNote(pending);
  }

  const sent = await send(pending.note, pending.updatedAt, mode);
  if (sent.kind === "held") {
    scheduleRetry();
    return localNote(pending);
  }

  // Off the outbox only if no newer edit was staged while this one was out.
  if (readPending(account, id)?.updatedAt === pending.updatedAt) {
    writePending(account, id, null);
  }
  if (sent.kind === "refused") {
    throw new Error("Could not save the note.");
  }
  retryStep = 0;
  return sent.note;
}

/** Send every pending write for the signed-in account. */
export async function flushNoteOutbox(mode: SendMode = "now"): Promise<void> {
  const account = confirmedEngineUser();
  if (!account) {
    return;
  }
  await Promise.all(pendingIds(account).map((id) => flushNote(id, mode).catch(() => null)));
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryStep = 0;

function scheduleRetry(): void {
  if (retryTimer) {
    return;
  }
  const wait = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)];
  retryStep++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void flushNoteOutbox();
  }, wait);
}
