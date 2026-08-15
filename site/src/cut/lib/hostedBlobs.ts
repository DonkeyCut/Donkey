"use client";

// Media leaves a hosted inference request through object storage.
//
// The hosted routes run as serverless functions behind a request-body limit
// enforced at the edge: an oversized body is refused before the route runs, so
// the upload resets mid-flight and fetch rejects with a bare "Failed to fetch".
// A video editor's requests are made of media — reference sheets, keyframes,
// contact sheets, chat attachments — and no amount of downscaling makes a
// request with several pictures reliably fit.
//
// So the bytes never ride the body. Every base64 payload above a trivial size is
// PUT straight to storage and replaced with `{ blobRef, blobField, mimeType }`;
// the route resolves those back into inline data server-side, where the request
// is server-to-server (lib/inference/blobs.ts). This runs inside hostedPost, so
// it covers every caller — generation, the scene pipeline's reviewers, chat —
// and no producer needs to know its picture travels separately.
//
// Anything that goes wrong here leaves the payload inline and the request goes
// out as it would have: storage is how a large request succeeds, never the
// reason a small one fails.
import { bytesFromBase64 } from "./bytes";
import { hostedFetch } from "./hosted";

/** Keys a hosted payload carries base64 media under, and the media type to
 * assume when the part does not name one. */
const PAYLOAD_KEYS: Record<string, string> = {
  data: "",
  dataBase64: "",
  data_base64: "",
  image_base64: "image/png",
  audio_base64: "audio/mpeg",
  video_base64: "video/mp4",
};

// Below this a round trip to storage costs more than the body it saves.
const MIN_OFFLOAD_BYTES = 32 * 1024;

// A stored object is addressed by its content hash, so a hash seen before needs
// no second upload. The sweep clears scratch objects after a day; reusing a
// mapping for a few hours stays well inside that.
const REUSE_MS = 6 * 60 * 60 * 1000;
const hosted = new Map<string, { key: string; at: number }>();

type Json = { [key: string]: unknown };

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const BASE64_HEAD = /^[A-Za-z0-9+/]{64}/;

/** The base64 payload this part carries, if any. */
function payloadOf(part: Json): { field: string; base64: string; mimeType: string } | null {
  for (const [field, fallback] of Object.entries(PAYLOAD_KEYS)) {
    const base64 = part[field];
    // A field named `data` is not always media, so the value has to read as
    // base64 and the part has to say what it is before anything is decoded.
    if (typeof base64 !== "string" || !BASE64_HEAD.test(base64)) continue;
    const declared =
      typeof part.mimeType === "string"
        ? part.mimeType
        : typeof part.mime_type === "string"
          ? part.mime_type
          : "";
    const mimeType = declared || fallback;
    // A payload whose media type nobody stated can't be stored with a type the
    // model will accept, so it stays inline.
    if (!mimeType) continue;
    return { field, base64, mimeType };
  }
  return null;
}

function decode(base64: string): Uint8Array | null {
  try {
    return bytesFromBase64(base64);
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Claim = { blobRef?: string; putUrl?: string; skipped?: string };

// One claim request covers this many blobs; the rest follow in more requests, so
// a contact sheet with dozens of frames is not a request nobody can send.
const CLAIM_BATCH = 16;

type Claimable = { sha256: string; mimeType: string; bytes: number };

/** Claim a storage key per blob, and the URL to PUT the ones not already there. */
async function claimKeys(blobs: Claimable[], clientId: string): Promise<Claim[]> {
  const batches: Claimable[][] = [];
  for (let i = 0; i < blobs.length; i += CLAIM_BATCH) {
    batches.push(blobs.slice(i, i + CLAIM_BATCH));
  }
  const claimed = await Promise.all(
    batches.map(async (batch) => {
      const unavailable = batch.map(() => ({ skipped: "unavailable" }));
      const res = await hostedFetch("/api/inference/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-donkey-client-id": clientId },
        body: JSON.stringify({ blobs: batch }),
      }).catch(() => null);
      if (!res?.ok) return unavailable;
      const body = (await res.json().catch(() => ({}))) as { blobs?: Claim[] };
      return body.blobs?.length === batch.length ? body.blobs : unavailable;
    })
  );
  return claimed.flat();
}

async function put(url: string, bytes: Uint8Array, mimeType: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: new Blob([bytes as unknown as BlobPart], { type: mimeType }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * A copy of `body` with its media payloads moved to storage and replaced by
 * references. Returns `body` itself when there is nothing worth moving.
 */
export async function offloadHostedMedia(body: unknown, clientId: string): Promise<unknown> {
  const parts: {
    part: Json;
    field: string;
    mimeType: string;
    bytes: Uint8Array;
  }[] = [];

  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!isObject(value)) return value;
    const found = payloadOf(value);
    if (found) {
      const bytes = decode(found.base64);
      if (bytes && bytes.byteLength >= MIN_OFFLOAD_BYTES) {
        const part: Json = { ...value };
        parts.push({ part, field: found.field, mimeType: found.mimeType, bytes });
        return part;
      }
      return { ...value };
    }
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewrite(v);
    return out;
  };

  const next = rewrite(body);
  if (parts.length === 0) return body;

  const hashes = await Promise.all(parts.map((p) => sha256Hex(p.bytes)));
  const fresh = Date.now() - REUSE_MS;
  const keys: (string | null)[] = hashes.map((hash) => {
    const known = hosted.get(hash);
    return known && known.at >= fresh ? known.key : null;
  });

  const claiming = parts
    .map((p, i) => ({ i, p, hash: hashes[i] }))
    .filter(({ i }) => keys[i] === null);
  if (claiming.length > 0) {
    const claims = await claimKeys(
      claiming.map(({ p, hash }) => ({
        sha256: hash,
        mimeType: p.mimeType,
        bytes: p.bytes.byteLength,
      })),
      clientId
    );
    await Promise.all(
      claiming.map(async ({ i, p, hash }, n) => {
        const claim = claims[n];
        if (!claim?.blobRef) return;
        if (claim.putUrl && !(await put(claim.putUrl, p.bytes, p.mimeType))) return;
        keys[i] = claim.blobRef;
        hosted.set(hash, { key: claim.blobRef, at: Date.now() });
      })
    );
  }

  for (const [i, key] of keys.entries()) {
    if (!key) continue; // stayed inline
    const { part, field, mimeType } = parts[i];
    delete part[field];
    part.blobRef = key;
    part.blobField = field;
    part.mimeType = mimeType;
  }
  return next;
}
