// The shared-media edge handler: serves one R2 object per request from
// Cloudflare's cache, gated by a short-lived token the hosted API mints
// (server/cloud/mediaCdn.ts holds the matching signer).
//
// Two things make this worth a Worker rather than a presigned R2 URL. The
// bucket stays private — this binding is the only way in, so access is a
// decision we make per request instead of arithmetic R2 does alone. And the
// cache key drops the query string, so every viewer and every re-mint of a
// rotating token collapse onto one cached copy per object; without that, a
// short token lifetime would mean a cache miss on every request.
//
// This file is compiled by wrangler, not the site's tsconfig — workers globals
// are typed loosely on purpose.
import { parseRange } from "../../server/cloud/httpRange";

type R2Range = { offset: number; length?: number };
type R2Object = {
  body: ReadableStream | null;
  size: number;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  writeHttpMetadata(headers: Headers): void;
};
type R2Bucket = {
  get(key: string, opts?: { range?: R2Range }): Promise<R2Object | null>;
  head(key: string): Promise<R2Object | null>;
};

export type MediaEnv = {
  CUT_MEDIA: R2Bucket;
  CUT_MEDIA_SIGNING_SECRET: string;
};

/** Cloudflare refuses to cache past this on Free/Pro/Business plans; a larger
 * object streams from R2 on every request instead of failing. */
const MAX_CACHEABLE_BYTES = 512 * 1024 * 1024;
/** How long the edge keeps an object. Media is immutable once written — a new
 * upload is a new key — so this is long and the token, not the cache, is what
 * bounds access. */
const EDGE_TTL_SECONDS = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();

async function signatureFor(secret: string, key: string, expires: number): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(`${key}\n${expires}`));
  // base64url, matching node's digest("base64url") on the signing side.
  let binary = "";
  for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time compare, so a wrong signature leaks nothing through timing. */
function sameSignature(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function baseHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", `public, max-age=${EDGE_TTL_SECONDS}, immutable`);
  return headers;
}

export async function serveMedia(
  request: Request,
  env: MediaEnv,
  ctx: { waitUntil(p: Promise<unknown>): void }
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const expires = Number(url.searchParams.get("e"));
  const sig = url.searchParams.get("s") ?? "";
  if (!key || !sig || !Number.isFinite(expires)) return new Response("Not found.", { status: 404 });
  // Expiry first: an expired token is the ordinary case once a share is
  // revoked, and it costs nothing to answer.
  if (expires * 1000 < Date.now()) return new Response("Link expired.", { status: 403 });
  if (!env.CUT_MEDIA_SIGNING_SECRET) return new Response("Not configured.", { status: 500 });
  if (!sameSignature(sig, await signatureFor(env.CUT_MEDIA_SIGNING_SECRET, key, expires))) {
    return new Response("Forbidden.", { status: 403 });
  }

  // The cache key is the object, never the token: tokens rotate every few
  // minutes and every viewer holds a different one, so keying on the full URL
  // would mean a miss per viewer per rotation. The stored entry is the whole
  // object; a Range on the lookup is what makes the cache answer 206 from it.
  const cacheUrl = `${url.origin}/${url.pathname.replace(/^\/+/, "")}`;
  const storeKey = new Request(cacheUrl, { method: "GET" });
  const rangeHeader = request.headers.get("range");
  const lookupKey = rangeHeader
    ? new Request(cacheUrl, { method: "GET", headers: { Range: rangeHeader } })
    : storeKey;
  const cache = caches.default;
  const hit = await cache.match(lookupKey);
  if (hit) return hit;

  const head = await env.CUT_MEDIA.head(key);
  if (!head) return new Response("Not found.", { status: 404 });

  const range = parseRange(rangeHeader, head.size);
  if (range === "invalid") {
    return new Response("Range not satisfiable.", {
      status: 416,
      headers: { "Content-Range": `bytes */${head.size}` },
    });
  }

  // Beyond the cacheable ceiling, stream the asked-for bytes straight through
  // and skip the cache — putting it would fail, and buffering it to try would
  // be worse than the miss.
  if (head.size > MAX_CACHEABLE_BYTES) {
    const object = await env.CUT_MEDIA.get(
      key,
      range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined
    );
    if (!object) return new Response("Not found.", { status: 404 });
    const headers = baseHeaders(object);
    headers.set("Cache-Control", "public, max-age=3600");
    if (range) {
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
      headers.set("Content-Length", String(range.end - range.start + 1));
      return new Response(object.body, { status: 206, headers });
    }
    headers.set("Content-Length", String(head.size));
    return new Response(object.body, { status: 200, headers });
  }

  // Warm the cache with the whole object, streamed. cache.put refuses a 206,
  // so the entry is always the full 200 — which is what lets later range
  // requests be answered from it.
  const warm = async () => {
    const whole = await env.CUT_MEDIA.get(key);
    if (!whole || !whole.body) return;
    const headers = baseHeaders(whole);
    headers.set("Content-Length", String(whole.size));
    await cache.put(storeKey, new Response(whole.body, { status: 200, headers }));
  };

  if (range) {
    // Serve the asked-for bytes from R2 directly and warm in the background.
    // Reading the whole object to slice it here would risk the Worker's memory
    // ceiling on exactly the large files that most need the cache.
    const part = await env.CUT_MEDIA.get(key, {
      range: { offset: range.start, length: range.end - range.start + 1 },
    });
    if (!part) return new Response("Not found.", { status: 404 });
    const headers = baseHeaders(part);
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    ctx.waitUntil(warm());
    return new Response(part.body, { status: 206, headers });
  }

  const object = await env.CUT_MEDIA.get(key);
  if (!object || !object.body) return new Response("Not found.", { status: 404 });
  const headers = baseHeaders(object);
  headers.set("Content-Length", String(object.size));
  const full = new Response(object.body, { status: 200, headers });
  ctx.waitUntil(cache.put(storeKey, full.clone()));
  return full;
}
