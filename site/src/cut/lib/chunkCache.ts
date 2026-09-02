"use client";

/**
 * Cloud media as resident byte ranges.
 *
 * A cloud video used to become local all at once: the prefetch streamed the
 * whole file into OPFS and playback rode signed URLs until the last byte
 * landed. This module makes residency a property of 2MB chunks. A decoder's
 * read serves resident chunks off disk, fetches the missing ones as ranged
 * requests, and writes what arrives — so the second scrub over a region is a
 * disk read, an interrupted prefetch keeps every chunk it landed, and a 6GB
 * source can be half here and half in R2.
 *
 * Identity survives token rotation but never survives a rewrite. A signed
 * media URL carries its key in the path and its auth in the query (`e`, `s`),
 * and the token window re-mints the query every hour
 * (server/cloud/mediaCdn.ts), so the key alone names the cache. The `v`
 * cache-version param moves whenever the bytes under a fixed key move, and it
 * names a directory *under* the key rather than joining the key's own hash:
 * two versions of one object must never share a directory, because both can
 * be open at once — a re-rendered proxy plays while the old decoder finishes
 * its frame — and interleaved writes would splice two files together.
 *
 * Fetches belong to the object, not to any one reader. Every open holds a
 * reference; requests in the air are cancelled when the last one goes, so
 * closing the editor stops the downloads while one decoder disposing mid-run
 * leaves another's bytes coming.
 *
 * The bytes are held in this tab once. Every reader on a file — the
 * picture's walk, the sound's, the peaks, the filmstrip — reads through the
 * same chunk memory here, sized from the tab's reads share, so a chunk one
 * of them just pulled off disk or the network serves the rest from memory
 * and none of them keeps a copy of its own past the few megabytes its walk
 * is standing on.
 *
 * A route URL — the page's own `/api/cut-cloud/.../media/...` address, which
 * an asset carries while it has no signed link — opens here too: the route
 * answers with a redirect to the signed object, and the object is what the
 * store keys on, so a reader on either address finds the same chunks.
 *
 * Everything here is a cache. A quota refusal, a torn write, or a browser
 * with no OPFS costs the network read it always cost; a read that cannot
 * reach the network at all is the one failure that propagates, and the
 * preview's outage recovery owns that.
 */

import {
  chunksDir,
  readFileAt,
  readJson,
  supportsBrowserStore,
  writeFileAt,
} from "./backend/browser/opfs";
import { CUT_MEDIA_ORIGIN } from "./hosts";
import { allowance, holdMemory } from "./memoryBudget";

export const CHUNK_SIZE = 2 * 1024 * 1024;
/** Longest single ranged request, in chunks, when a read needs a missing run. */
const MAX_RUN = 8;
/** Chunks per request when the background prefetch walks a file. */
const PREFETCH_RUN = 4;
const META = "meta.json";
/** How long one storage estimate stands in for the next. */
const ESTIMATE_TTL_MS = 15_000;
/** Free space kept under quota beyond what a write needs — the same margin
 * the whole-file cache holds (mediaSync.ts). */
const QUOTA_MARGIN = 512 * 1024 * 1024;
const FETCH_ATTEMPTS = 3;
/** After the store refuses a write, wait this long before asking again. A
 * refusal is a moment's verdict: an eviction elsewhere can free hundreds of
 * megabytes seconds later, and an object that latched off would never notice. */
const PERSIST_RETRY_MS = 30_000;
/** Chunks written between meta commits. The resident map is what saves a
 * reopened file from enumerating thousands of directory entries, and it is
 * safe to lag: a claim the disk can't back costs one refetch. */
const META_EVERY = 8;

/** What one signed URL resolves to in the store. */
export interface ChunkIdentity {
  /** Decoded R2 key path, e.g. `/cut/<uid>/projects/<id>/media/<file>`. */
  key: string;
  /** The URL's `v` cache-version param; a rewrite in place moves it. */
  version: string;
  /** Directory naming the key. Holds one child per version. */
  keyHash: string;
  /** Directory naming this version's chunks, under `keyHash`. */
  versionTag: string;
}

interface ChunkMeta {
  key: string;
  version: string;
  size: number;
  chunk: number;
  /** Last use, for eviction recency. */
  at: number;
  /** Resident chunk indices as a base64 bitmap, LSB-first per byte. */
  resident?: string;
}

interface ObjState {
  id: ChunkIdentity;
  /** The freshest signed URL seen for this object; rotation swaps it in. */
  url: string;
  dir: FileSystemDirectoryHandle | null;
  size: number;
  /** Chunk indices believed to be on disk. Optimistic: a claim the disk can't
   * back costs one refetch, so a lagging meta is safe. */
  resident: Set<number>;
  /** Chunk indices with a fetch in the air, shared across readers. */
  inflight: Map<number, Promise<Uint8Array>>;
  /** Live opens. Requests are cancelled when this reaches zero. */
  refs: number;
  /** Cancels this object's requests; replaced once it has fired. */
  ac: AbortController;
  /** When the store last refused a write; reads keep working uncached until
   * `PERSIST_RETRY_MS` has passed. */
  refusedAt: number;
  /** The size probe's bytes, serving chunk 0 until its write commits. */
  probe0: Uint8Array | null;
  /** Chunk writes since the last meta commit. */
  dirty: number;
  /** True once this object's directory has been taken out from under it. */
  dead: boolean;
}

/** Parse a URL into a chunk identity, or null for anything this cache does
 * not hold: other origins, and tree-token paths (HLS ladders play through
 * their own player buffering). */
export function chunkIdentity(url: string): ChunkIdentity | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== CUT_MEDIA_ORIGIN || u.pathname.startsWith("/_t/")) return null;
  const key = u.pathname
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/");
  const version = u.searchParams.get("v") ?? "";
  return { key, version, keyHash: hash16(key), versionTag: hash16(version).slice(0, 8) };
}

/** FNV-1a over the input, twice with different seeds, as a directory name. */
function hash16(s: string): string {
  const pass = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return pass(0x811c9dc5) + pass(0x9747b28c);
}

/** Group sorted chunk indices into consecutive runs no longer than `cap`. */
export function chunkRuns(indices: number[], cap: number): [number, number][] {
  const runs: [number, number][] = [];
  for (const i of indices) {
    const last = runs[runs.length - 1];
    if (last && i === last[1] + 1 && last[1] - last[0] + 1 < cap) last[1] = i;
    else runs.push([i, i]);
  }
  return runs;
}

/** Resident indices as a base64 bitmap, and back. */
export function encodeResident(resident: Iterable<number>, total: number): string {
  const bytes = new Uint8Array(Math.ceil(total / 8));
  for (const i of resident) {
    if (i >= 0 && i < total) bytes[i >> 3] |= 1 << (i & 7);
  }
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function decodeResident(b64: string, total: number): Set<number> {
  const out = new Set<number>();
  let s: string;
  try {
    s = atob(b64);
  } catch {
    return out;
  }
  for (let i = 0; i < total; i++) {
    if ((s.charCodeAt(i >> 3) || 0) & (1 << (i & 7))) out.add(i);
  }
  return out;
}

const chunkCount = (size: number) => Math.ceil(size / CHUNK_SIZE);
const chunkLen = (idx: number, size: number) => Math.min(CHUNK_SIZE, size - idx * CHUNK_SIZE);

/**
 * The page's own media routes: a project's file or a library file on the
 * cloud surface, and a shared view's project file, which reaches the owner's
 * bytes through a share token.
 *
 * Both redirect to the media origin, which is the address the store holds an
 * object under, so someone reading a cut shared with them holds the file once
 * for every reader on it, the way its owner does.
 */
const ROUTE_MEDIA_PATH =
  /^\/api\/cut-(?:cloud|shared\/[^/]+)\/(?:projects\/[^/]+|library)\/media\/[^/]+$/;

/** A route URL as this page would fetch it, or null for any other address.
 * Relative routes resolve against the page; an absolute one has to be the
 * page's own origin, since that is the only server that answers them. */
export function routeMediaUrl(
  url: string,
  origin = typeof location === "undefined" ? "" : location.origin
): string | null {
  if (!origin) return null;
  let u: URL;
  try {
    u = new URL(url, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin || !ROUTE_MEDIA_PATH.test(u.pathname)) return null;
  return u.href;
}

// --- memory ---

/**
 * Chunks held in memory, once each, for every reader on the object.
 *
 * Least recently touched goes first when the cap is reached. A chunk is keyed
 * by the object version it belongs to, so two versions of one object never
 * answer for each other, and forgetting a version drops everything it held.
 */
export class ChunkMemory {
  private chunks = new Map<string, Uint8Array>();
  private bytes = 0;

  constructor(private readonly cap: () => number) {}

  /** Bytes held right now. */
  get held(): number {
    return this.bytes;
  }

  recall(scope: string, idx: number): Uint8Array | null {
    const k = `${scope}/${idx}`;
    const hit = this.chunks.get(k);
    if (!hit) return null;
    this.chunks.delete(k);
    this.chunks.set(k, hit);
    return hit;
  }

  remember(scope: string, idx: number, bytes: Uint8Array): void {
    const k = `${scope}/${idx}`;
    const prior = this.chunks.get(k);
    if (prior) {
      this.bytes -= prior.length;
      this.chunks.delete(k);
    }
    const cap = this.cap();
    if (bytes.length > cap) return;
    this.chunks.set(k, bytes);
    this.bytes += bytes.length;
    while (this.bytes > cap) {
      const oldest = this.chunks.keys().next().value!;
      this.bytes -= this.chunks.get(oldest)!.length;
      this.chunks.delete(oldest);
    }
  }

  forget(scope: string): void {
    for (const [k, bytes] of this.chunks) {
      if (k.startsWith(`${scope}/`)) {
        this.bytes -= bytes.length;
        this.chunks.delete(k);
      }
    }
  }
}

/** What the chunk memory was tuned to hold: a minute of a phone recording,
 * which is the stretch the picture, the sound and the peaks are all reading
 * from at once. */
const MEMORY_TUNED = 128 * 2 ** 20;
/** Decided once: the ceiling does not move, and every ask re-records the
 * same pressure. */
let memoryCap = 0;
const memory = new ChunkMemory(
  () => (memoryCap ||= allowance("chunkMemory", MEMORY_TUNED))
);
holdMemory("chunkMemory", () => memory.held);

// --- open ---

const states = new Map<string, Promise<ObjState>>();
const stateKey = (id: ChunkIdentity) => `${id.keyHash}/${id.versionTag}`;

function openObject(id: ChunkIdentity, url: string): Promise<ObjState> {
  const k = stateKey(id);
  const prior = states.get(k);
  // A later open carries a fresher token; the state's fetches follow it.
  if (prior) return prior.then((s) => ((s.url = url), s));
  const p = doOpen(id, url).catch((err) => {
    states.delete(k);
    throw err;
  });
  states.set(k, p);
  return p;
}

async function doOpen(id: ChunkIdentity, url: string): Promise<ObjState> {
  const dir = await versionDir(id);
  const state: ObjState = {
    id,
    url,
    dir,
    size: 0,
    resident: new Set(),
    inflight: new Map(),
    refs: 0,
    ac: new AbortController(),
    refusedAt: 0,
    probe0: null,
    dirty: 0,
    dead: false,
  };
  const meta = await readJson<ChunkMeta>(dir, META);
  if (
    meta &&
    meta.key === id.key &&
    meta.version === id.version &&
    meta.chunk === CHUNK_SIZE &&
    Number.isInteger(meta.size) &&
    meta.size >= 0
  ) {
    state.size = meta.size;
    const total = chunkCount(meta.size);
    state.resident = meta.resident
      ? decodeResident(meta.resident, total)
      : await scanResident(dir, total);
    void commitMeta(state);
    return state;
  }
  // No usable meta: whatever is in there answers for bytes we can't vouch
  // for. Start clean.
  if (dir) await wipe(dir);
  const res = await fetchRange(url, 0, CHUNK_SIZE - 1);
  if (res.status === 206) {
    const total = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1];
    if (!total) throw new Error("Cloud media answered a range with no total size.");
    state.size = Number(total);
    state.probe0 = await collect(res, 0, Math.min(CHUNK_SIZE, state.size) - 1, false);
  } else if (res.ok) {
    // The range was ignored. Content-Length is the whole file; take chunk 0
    // off the front and drop the rest rather than buffering a 6GB body.
    state.size = Number(res.headers.get("content-length") ?? 0);
    if (!state.size) throw new Error("Cloud media answered with no length.");
    state.probe0 = await collect(res, 0, Math.min(CHUNK_SIZE, state.size) - 1, true);
  } else {
    throw new Error(`Cloud media read failed (${res.status}).`);
  }
  void persistChunk(state, 0, state.probe0);
  void commitMeta(state);
  return state;
}

/** `chunks/<keyHash>/<versionTag>/`, with every other version of the same key
 * swept as it is opened. An object rewritten in place leaves its old chunks
 * behind exactly once, and the next open of the new bytes collects them. */
async function versionDir(id: ChunkIdentity): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsBrowserStore()) return null;
  try {
    const root = await chunksDir(true);
    if (!root) return null;
    const parent = await root.getDirectoryHandle(id.keyHash, { create: true });
    const stale: string[] = [];
    for await (const [name, h] of parent) {
      if (h.kind === "directory" && name !== id.versionTag) stale.push(name);
    }
    for (const name of stale) {
      await parent.removeEntry(name, { recursive: true }).catch(() => {});
      // A reader still holding the old version reads on, from the network.
      const old = states.get(`${id.keyHash}/${name}`);
      if (old) {
        states.delete(`${id.keyHash}/${name}`);
        void old
          .then((s) => {
            s.dead = true;
            s.dir = null;
            s.resident.clear();
          })
          .catch(() => {});
      }
    }
    return await parent.getDirectoryHandle(id.versionTag, { create: true });
  } catch {
    return null;
  }
}

/** Recover residency by enumerating chunk files. The repair path only — a
 * meta with a resident map spares thousands of directory reads on open. */
async function scanResident(
  dir: FileSystemDirectoryHandle | null,
  total: number
): Promise<Set<number>> {
  const out = new Set<number>();
  if (!dir) return out;
  try {
    for await (const [name, h] of dir) {
      if (h.kind !== "file" || !/^\d+$/.test(name)) continue;
      const idx = Number(name);
      if (idx < total) out.add(idx);
    }
  } catch {
    out.clear();
  }
  return out;
}

async function commitMeta(state: ObjState): Promise<void> {
  if (!state.dir || state.dead) return;
  state.dirty = 0;
  const meta: ChunkMeta = {
    key: state.id.key,
    version: state.id.version,
    size: state.size,
    chunk: CHUNK_SIZE,
    at: Date.now(),
    resident: encodeResident(state.resident, chunkCount(state.size)),
  };
  try {
    await writeFileAt(state.dir, META, JSON.stringify(meta));
  } catch {
    // Residency and recency go stale; reads refetch and the object ages
    // toward eviction faster.
  }
}

async function wipe(dir: FileSystemDirectoryHandle): Promise<void> {
  const names: string[] = [];
  try {
    for await (const [name] of dir) names.push(name);
  } catch {
    return;
  }
  for (const name of names) await dir.removeEntry(name, { recursive: true }).catch(() => {});
}

// --- refcounting ---

function acquire(state: ObjState): void {
  if (state.refs === 0 && state.ac.signal.aborted) state.ac = new AbortController();
  state.refs++;
}

function release(state: ObjState): void {
  state.refs = Math.max(0, state.refs - 1);
  if (state.refs > 0) return;
  // Nothing is reading this object: stop what is still coming down, and let
  // the probe copy go. What landed on disk stays.
  state.ac.abort();
  state.probe0 = null;
  if (state.dirty) void commitMeta(state);
}

// --- reads ---

/** Wait out a backoff, or give up early when the object is torn down. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function fetchRange(
  url: string,
  start: number,
  endInclusive: number,
  signal?: AbortSignal
): Promise<Response> {
  let delay = 400;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${endInclusive}` },
        signal,
      });
      // 4xx is the URL's own verdict — an expired token re-mints upstream
      // (mediaLinks.ts), and retrying the same string here would stall that.
      if (res.ok || attempt >= FETCH_ATTEMPTS || (res.status >= 400 && res.status < 500)) return res;
    } catch (err) {
      if (signal?.aborted || attempt >= FETCH_ATTEMPTS) throw err;
    }
    await sleep(delay, signal ?? new AbortController().signal);
    delay *= 3;
  }
}

/**
 * Walk `[start, end]` out of a response body, handing over each stretch of
 * wanted bytes as it arrives. When `fromZero`, the body starts at byte 0
 * whatever was asked for, so the front is streamed past and the rest is
 * dropped without ever being buffered. The bytes handed to `onBytes` are a
 * view on the reader's own buffer, so a caller copies them there and then.
 * Throws when the body ends before the range is covered.
 */
async function walkBody(
  res: Response,
  start: number,
  endInclusive: number,
  fromZero: boolean,
  onBytes: (bytes: Uint8Array) => void
): Promise<void> {
  const want = endInclusive - start + 1;
  const reader = res.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await res.arrayBuffer());
    const from = fromZero ? start : 0;
    if (all.length < from + want) throw new Error("Cloud media returned a short range.");
    onBytes(all.subarray(from, from + want));
    return;
  }
  let pos = fromZero ? 0 : start; // absolute position of the next byte read
  let filled = 0;
  try {
    while (filled < want) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkStart = pos;
      pos += value.length;
      const from = Math.max(start, chunkStart);
      const to = Math.min(endInclusive + 1, pos);
      if (to > from) {
        onBytes(value.subarray(from - chunkStart, to - chunkStart));
        filled += to - from;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (filled < want) throw new Error("Cloud media returned a short range.");
}

/** Read `[start, end]` out of a response body into one buffer. */
export async function collect(
  res: Response,
  start: number,
  endInclusive: number,
  fromZero: boolean
): Promise<Uint8Array> {
  const out = new Uint8Array(endInclusive - start + 1);
  let at = 0;
  await walkBody(res, start, endInclusive, fromZero, (bytes) => {
    out.set(bytes, at);
    at += bytes.length;
  });
  return out;
}

/**
 * Read a run's body, handing each chunk over the moment its own bytes arrive.
 *
 * A run is up to `MAX_RUN` chunks in one request, which is the right shape for
 * the network — one round trip carries eight chunks. It is the wrong shape for
 * the reader waiting on the first of them, and that reader is usually the preview.
 * Held until the last byte of the run lands, a read of two megabytes waits for
 * sixteen: on a link with real headroom that is seconds of waiting for bytes
 * that arrived at the start, and the picture sits behind the sound for every
 * one of them. Settling at each chunk's own boundary keeps the round trip and
 * gives the reader its bytes when they exist.
 */
export async function streamRun(
  res: Response,
  start: number,
  endInclusive: number,
  fromZero: boolean,
  onChunk: (index: number, bytes: Uint8Array) => void
): Promise<void> {
  const first = Math.floor(start / CHUNK_SIZE);
  const total = endInclusive - start + 1;
  // The chunk being assembled, how much of it is filled, and how much of the
  // run has already been handed over.
  let chunk = new Uint8Array(Math.min(CHUNK_SIZE, total));
  let filled = 0;
  let done = 0;
  await walkBody(res, start, endInclusive, fromZero, (bytes) => {
    let at = 0;
    while (at < bytes.length) {
      const take = Math.min(chunk.length - filled, bytes.length - at);
      chunk.set(bytes.subarray(at, at + take), filled);
      filled += take;
      at += take;
      if (filled === chunk.length) {
        onChunk(first + done / CHUNK_SIZE, chunk);
        done += filled;
        filled = 0;
        chunk = new Uint8Array(Math.min(CHUNK_SIZE, total - done));
      }
    }
  });
}

/** Fetch one missing run, resolving each chunk to every reader waiting on it
 * and writing it to the store as it settles. */
function startRun(state: ObjState, first: number, last: number): Promise<Uint8Array>[] {
  const settles: { resolve: (b: Uint8Array) => void; reject: (e: unknown) => void }[] = [];
  const promises: Promise<Uint8Array>[] = [];
  for (let i = first; i <= last; i++) {
    let settle!: (typeof settles)[number];
    const p = new Promise<Uint8Array>((resolve, reject) => (settle = { resolve, reject }));
    // Nothing may reach an unhandled rejection: a run can outlive the read
    // that started it, and every consumer attaches its own handler.
    p.catch(() => {});
    settles.push(settle);
    promises.push(p);
    state.inflight.set(i, p);
    const drop = () => {
      if (state.inflight.get(i) === p) state.inflight.delete(i);
    };
    p.then(drop, drop);
  }
  void (async () => {
    try {
      const startB = first * CHUNK_SIZE;
      const endB = Math.min(state.size, (last + 1) * CHUNK_SIZE) - 1;
      const res = await fetchRange(state.url, startB, endB, state.ac.signal);
      if (!res.ok) throw new Error(`Cloud media read failed (${res.status}).`);
      // Each chunk is its own array, so holding one can't pin the whole run,
      // and it settles the moment its own bytes are here.
      await streamRun(res, startB, endB, res.status !== 206, (i, bytes) => {
        settles[i - first].resolve(bytes);
        void persistChunk(state, i, bytes);
      });
    } catch (err) {
      // A chunk already handed over ignores this; the rest of the run fails.
      for (const s of settles) s.reject(err);
    }
  })();
  return promises;
}

async function residentBytes(state: ObjState, idx: number): Promise<Uint8Array | null> {
  const file = await readFileAt(state.dir, String(idx));
  if (!file || file.size !== chunkLen(idx, state.size)) {
    state.resident.delete(idx);
    return null;
  }
  return new Uint8Array(await file.arrayBuffer());
}

/** Read `[start, end)`, serving resident chunks and fetching missing ones in
 * coalesced runs. Returns exactly `end - start` bytes or throws. */
async function readRange(state: ObjState, start: number, end: number): Promise<Uint8Array> {
  end = Math.min(end, state.size);
  const out = new Uint8Array(Math.max(0, end - start));
  if (!out.length) return out;
  const c0 = Math.floor(start / CHUNK_SIZE);
  const c1 = Math.floor((end - 1) / CHUNK_SIZE);
  const place = (idx: number, bytes: Uint8Array) => {
    const base = idx * CHUNK_SIZE;
    const from = Math.max(start, base);
    const to = Math.min(end, base + bytes.length);
    if (to > from) out.set(bytes.subarray(from - base, to - base), from - start);
  };
  // Plan first: serve what memory holds, pin the fetches already in the air,
  // then open one run per consecutive stretch that has to touch the network.
  const scope = stateKey(state.id);
  const have = new Map<number, Promise<Uint8Array>>();
  const served = new Set<number>();
  const need: number[] = [];
  for (let i = c0; i <= c1; i++) {
    const mem = memory.recall(scope, i);
    if (mem) {
      // Already in memory: copied out here, so nothing holds the chunk open
      // while the rest of the read waits on the network.
      place(i, mem);
      served.add(i);
    } else {
      const flying = state.inflight.get(i);
      if (flying) have.set(i, flying);
      else if (!state.resident.has(i) && !(i === 0 && state.probe0)) need.push(i);
    }
  }
  for (const [a, b] of chunkRuns(need, MAX_RUN)) {
    const runPromises = startRun(state, a, b);
    for (let i = a; i <= b; i++) have.set(i, runPromises[i - a]);
  }
  const keep = (idx: number, bytes: Uint8Array) => {
    memory.remember(scope, idx, bytes);
    return bytes;
  };
  await Promise.all(
    Array.from({ length: c1 - c0 + 1 }, async (_, k) => {
      const idx = c0 + k;
      if (served.has(idx)) return;
      const planned = have.get(idx);
      if (planned) return place(idx, keep(idx, await planned));
      if (idx === 0 && state.probe0 && !state.resident.has(0)) return place(0, state.probe0);
      const disk = await residentBytes(state, idx);
      if (disk) return place(idx, keep(idx, disk));
      // The disk copy vanished under us (evicted mid-read); fetch it alone.
      const [refetch] = startRun(state, idx, idx);
      place(idx, keep(idx, await refetch));
    })
  );
  return out;
}

// --- persistence and room ---

function canPersist(state: ObjState): boolean {
  if (!state.dir || state.dead) return false;
  return !state.refusedAt || Date.now() - state.refusedAt >= PERSIST_RETRY_MS;
}

async function persistChunk(state: ObjState, idx: number, bytes: Uint8Array): Promise<void> {
  if (!canPersist(state)) return;
  if (!(await roomFor(bytes.length, state.id.keyHash))) {
    state.refusedAt = Date.now();
    return;
  }
  try {
    await writeFileAt(state.dir!, String(idx), new Blob([bytes as BlobPart]));
    state.resident.add(idx);
    if (idx === 0) state.probe0 = null;
    if (++state.dirty >= META_EVERY) void commitMeta(state);
  } catch {
    // A cache write only; the bytes were already served. The reservation goes
    // back so a run of failures can't talk the store into believing it's full.
    refund(bytes.length);
  }
}

let lastEstimate: { at: number; usage: number; quota: number } | null = null;

function refund(bytes: number): void {
  if (lastEstimate) lastEstimate.usage = Math.max(0, lastEstimate.usage - bytes);
}

async function roomFor(bytes: number, keepKeyHash: string): Promise<boolean> {
  try {
    if (!lastEstimate || Date.now() - lastEstimate.at > ESTIMATE_TTL_MS) {
      const est = await navigator.storage.estimate?.();
      if (!est?.quota) return true;
      lastEstimate = { at: Date.now(), usage: est.usage ?? 0, quota: est.quota };
    }
  } catch {
    return true;
  }
  const margin = Math.min(QUOTA_MARGIN, lastEstimate.quota * 0.1);
  let deficit = lastEstimate.usage + bytes + margin - lastEstimate.quota;
  if (deficit > 0) {
    const freed = await evictChunkBytes(deficit, keepKeyHash);
    refund(freed);
    deficit -= freed;
  }
  if (deficit > 0) return false;
  lastEstimate.usage += bytes;
  return true;
}

/** One cached version of one object, as eviction sees it. */
interface Candidate {
  keyHash: string;
  versionTag: string;
  at: number;
  bytes: number;
}

async function listCached(keepKeyHash?: string): Promise<Candidate[]> {
  const root = await chunksDir();
  if (!root) return [];
  const out: Candidate[] = [];
  try {
    for await (const [keyHash, h] of root) {
      if (h.kind !== "directory" || keyHash === keepKeyHash) continue;
      const parent = await root.getDirectoryHandle(keyHash).catch(() => null);
      if (!parent) continue;
      for await (const [versionTag, vh] of parent) {
        if (vh.kind !== "directory") continue;
        const dir = await parent.getDirectoryHandle(versionTag).catch(() => null);
        const meta = await readJson<ChunkMeta>(dir, META);
        out.push({
          keyHash,
          versionTag,
          at: meta?.at ?? 0,
          bytes: meta ? residentBytesOf(meta) : 0,
        });
      }
    }
  } catch {
    return out;
  }
  return out;
}

/** What a cached version actually occupies, from its own meta — the last
 * chunk is short, so counting every chunk at full size over-reports and
 * leaves `makeRoom` believing it freed room it did not. */
function residentBytesOf(meta: ChunkMeta): number {
  if (!meta.resident || !meta.size) return 0;
  let total = 0;
  for (const i of decodeResident(meta.resident, chunkCount(meta.size))) {
    total += Math.min(CHUNK_SIZE, meta.size - i * CHUNK_SIZE);
  }
  return total;
}

/** Free chunk-store bytes toward `deficit`, dropping least recently used
 * versions first. Returns the bytes freed. The whole-file cache's makeRoom
 * spends this store before its own — a chunk is the cheapest byte to lose. */
export async function evictChunkBytes(deficit: number, keepKeyHash?: string): Promise<number> {
  if (deficit <= 0 || !supportsBrowserStore()) return 0;
  const candidates = await listCached(keepKeyHash);
  candidates.sort((a, b) => a.at - b.at);
  let freed = 0;
  for (const c of candidates) {
    if (freed >= deficit) break;
    freed += await removeVersion(c.keyHash, c.versionTag, c.bytes);
  }
  return freed;
}

async function removeVersion(keyHash: string, versionTag: string, bytes: number): Promise<number> {
  const root = await chunksDir();
  if (!root) return 0;
  try {
    const parent = await root.getDirectoryHandle(keyHash);
    await parent.removeEntry(versionTag, { recursive: true });
    // An empty key directory is litter; the next estimate shouldn't walk it.
    let empty = true;
    for await (const entry of parent) {
      void entry;
      empty = false;
      break;
    }
    if (empty) await root.removeEntry(keyHash, { recursive: true }).catch(() => {});
  } catch {
    return 0;
  }
  const k = `${keyHash}/${versionTag}`;
  memory.forget(k);
  const live = states.get(k);
  if (live) {
    states.delete(k);
    // A live reader heals to the network on its next miss.
    void live
      .then((s) => {
        s.dead = true;
        s.dir = null;
        s.resident.clear();
      })
      .catch(() => {});
  }
  return bytes;
}

/** Drop every cached object whose key contains `part` — the local half of a
 * media or project delete. */
export async function dropChunksMatching(part: string): Promise<void> {
  if (!supportsBrowserStore()) return;
  const root = await chunksDir();
  if (!root) return;
  const doomed: Candidate[] = [];
  try {
    for await (const [keyHash, h] of root) {
      if (h.kind !== "directory") continue;
      const parent = await root.getDirectoryHandle(keyHash).catch(() => null);
      if (!parent) continue;
      for await (const [versionTag, vh] of parent) {
        if (vh.kind !== "directory") continue;
        const dir = await parent.getDirectoryHandle(versionTag).catch(() => null);
        const meta = await readJson<ChunkMeta>(dir, META);
        if (meta?.key.includes(part)) {
          doomed.push({ keyHash, versionTag, at: 0, bytes: residentBytesOf(meta) });
        }
      }
    }
  } catch {
    return;
  }
  for (const d of doomed) refund(await removeVersion(d.keyHash, d.versionTag, d.bytes));
}

// --- the seams ---

/**
 * Open the object a route URL redirects to.
 *
 * The route answers a ranged read with a redirect to the signed object, and
 * the URL the bytes came from is the one the store keys on. One byte is
 * enough to learn it; the body is let go before the object opens, so the
 * open reads chunk 0 the way every open does.
 */
/**
 * Route probes in the air, by route URL.
 *
 * Every reader on a file opens at once — the picture, the sound, the peaks,
 * the filmstrip — and each learns the object's address only from its own
 * probe, so without this each would spend a round trip through the route
 * (which signs a URL, and for a share resolves the share) before `states`
 * could hold them together. The memo is dropped the moment the probe settles,
 * so a reader opening later still asks the route for a freshly signed URL.
 */
const probes = new Map<string, Promise<ObjState>>();

function openThroughRoute(route: string): Promise<ObjState> {
  const flying = probes.get(route);
  if (flying) return flying;
  const probe = probeRoute(route).finally(() => {
    if (probes.get(route) === probe) probes.delete(route);
  });
  probes.set(route, probe);
  return probe;
}

async function probeRoute(route: string): Promise<ObjState> {
  const res = await fetchRange(route, 0, 0);
  if (!res.ok) throw new Error(`Cloud media read failed (${res.status}).`);
  await res.body?.cancel().catch(() => {});
  const id = chunkIdentity(res.url);
  if (!id) throw new Error("Cloud media route did not land on the media origin.");
  return openObject(id, res.url);
}

/** CustomSource callbacks over the chunk store for a signed cloud media URL
 * or the page's own route to one, or null when the URL is neither or this
 * browser holds no store — the caller falls back to a plain URL source.
 * `dispose` releases the object, which cancels its requests once nothing else
 * is reading it. */
export function chunkSourceOptions(url: string): {
  getSize: () => Promise<number>;
  read: (start: number, end: number) => Promise<Uint8Array>;
  dispose: () => void;
} | null {
  if (!supportsBrowserStore()) return null;
  const id = chunkIdentity(url);
  const route = id ? null : routeMediaUrl(url);
  if (!id && !route) return null;
  let opened: Promise<ObjState> | null = null;
  let disposed = false;
  const open = () =>
    (opened ??= (id ? openObject(id, url) : openThroughRoute(route!)).then((s) => {
      if (disposed) throw new DOMException("Aborted", "AbortError");
      acquire(s);
      return s;
    }));
  return {
    getSize: async () => (await open()).size,
    read: async (start, end) => readRange(await open(), start, end),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      void opened?.then(release).catch(() => {});
    },
  };
}

/**
 * Carry one object's resident bytes to another key holding the same bytes.
 *
 * An import that lands moves an asset off the URL it arrived on — a library
 * file copied into the project — and the copy is byte-identical, so what the
 * session already read under the old key answers for the new one: the play
 * that ran, the waveform and filmstrip decodes, a prefetch. Left behind,
 * the whole session reads cold off the new key while the same bytes sit
 * resident a directory away — the roughness a clip shows on its first
 * session and never after a reload, because a reload holds one key all
 * session. Chunk files are copied and the source keeps its own; a carry
 * that fails costs only the refetch it always cost.
 */
export async function adoptChunks(fromUrl: string, toUrl: string): Promise<void> {
  if (!supportsBrowserStore()) return;
  const from = chunkIdentity(fromUrl);
  const to = chunkIdentity(toUrl);
  if (!from || !to || stateKey(from) === stateKey(to)) return;
  try {
    const root = await chunksDir(false);
    if (!root) return;
    const srcDir = await (await root.getDirectoryHandle(from.keyHash)).getDirectoryHandle(
      from.versionTag
    );
    const meta = await readJson<ChunkMeta>(srcDir, META);
    if (
      !meta ||
      meta.key !== from.key ||
      meta.chunk !== CHUNK_SIZE ||
      !Number.isInteger(meta.size) ||
      meta.size <= 0
    )
      return;
    const total = chunkCount(meta.size);
    const resident = meta.resident
      ? decodeResident(meta.resident, total)
      : await scanResident(srcDir, total);
    if (resident.size === 0) return;
    const dest = await versionDir(to);
    if (!dest) return;
    const copied = new Set<number>();
    for (const idx of [...resident].sort((a, b) => a - b)) {
      const bytes = await readFileAt(srcDir, String(idx));
      // A file the map names but the disk cannot back, or one of the wrong
      // length, answers for bytes it does not hold; it stays behind.
      if (!bytes || bytes.size !== chunkLen(idx, meta.size)) continue;
      await writeFileAt(dest, String(idx), bytes);
      copied.add(idx);
    }
    if (copied.size === 0) return;
    const out: ChunkMeta = {
      key: to.key,
      version: to.version,
      size: meta.size,
      chunk: CHUNK_SIZE,
      at: Date.now(),
      resident: encodeResident(copied, total),
    };
    await writeFileAt(dest, META, JSON.stringify(out));
    // A reader already holding the destination open learns what landed.
    const open = states.get(stateKey(to));
    if (open)
      void open
        .then((s) => {
          if (s.dead) return;
          if (!s.size) s.size = meta.size;
          for (const i of copied) s.resident.add(i);
        })
        .catch(() => {});
  } catch {
    // A cache that could not be carried is a cache that never was: the next
    // open probes and reads over the network, exactly as before.
  }
}

/** Walk a file's chunks into the store front to back, skipping what is
 * already resident or in the air. Stops on abort, on a store that has run out
 * of room, and on a network failure — every chunk that landed stays. */
export async function prefetchChunks(url: string, signal: AbortSignal): Promise<void> {
  if (!supportsBrowserStore() || signal.aborted) return;
  const id = chunkIdentity(url);
  if (!id) return;
  const state = await openObject(id, url);
  if (!state.dir) return;
  acquire(state);
  try {
    const total = chunkCount(state.size);
    for (let i = 0; i < total; i++) {
      if (signal.aborted || !canPersist(state)) return;
      if (state.resident.has(i) || state.inflight.has(i)) continue;
      let last = i;
      while (
        last - i + 1 < PREFETCH_RUN &&
        last + 1 < total &&
        !state.resident.has(last + 1) &&
        !state.inflight.has(last + 1)
      ) {
        last++;
      }
      try {
        await Promise.all(startRun(state, i, last));
      } catch {
        return; // a blip leaves this file partial; reads finish the rest on demand
      }
      i = last;
    }
  } finally {
    if (state.dirty) await commitMeta(state);
    release(state);
  }
}
