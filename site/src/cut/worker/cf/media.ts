// The shared-media edge handler: serves R2 objects from Cloudflare's cache,
// gated by a short-lived token the hosted API mints (server/cloud/mediaCdn.ts
// holds the matching signer).
//
// Two things make this worth a Worker rather than a presigned R2 URL. The
// bucket stays private — this binding is the only way in, so access is a
// decision we make per request instead of arithmetic R2 does alone. And the
// cache key is the object, never the token, so every viewer and every re-mint
// of a rotating token collapse onto one cached copy; without that, a short
// token lifetime would mean a cache miss on every request.
//
// Tokens come in two shapes. An object token names one key. A tree token names
// a prefix and rides in the path so that an HLS player, which follows relative
// URIs out of a playlist, keeps its authorization across the hop to the
// segments — a query string would not survive it.
//
// This file is compiled by wrangler, not the site's tsconfig — workers globals
// are typed loosely on purpose.
import { parseRange } from "../../server/cloud/httpRange";
import { contentDisposition, mediaDownloadName } from "../../server/cloud/mediaName";

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
/** How long a playlist may be held. Short, because a ladder rewrites its master
 * as later rungs finish — long enough to absorb a crowd opening one link, short
 * enough that the finished ladder reaches them. */
const PLAYLIST_TTL_SECONDS = 60;

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  // base64url, matching node's digest("base64url") on the signing side.
  let binary = "";
  for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const signatureFor = (
  secret: string,
  key: string,
  expires: number,
  downloadName: string,
  version: string
): Promise<string> => hmac(secret, `${key}\n${expires}\n${downloadName}\n${version}`);

/** The tree-token signature — see mediaCdn.ts for why an HLS ladder needs a
 * token that survives relative URI resolution. Framed differently from the
 * object signature so neither can stand in for the other. */
const treeSignatureFor = (secret: string, prefix: string, expires: number): Promise<string> =>
  hmac(secret, `tree\n${prefix}\n${expires}`);

/** Marks a tree-token path: /_t/<expires>/<depth>/<sig>/<key…>. */
const TREE_PREFIX = "_t";

/** Constant-time compare, so a wrong signature leaks nothing through timing. */
function sameSignature(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The editor loads every decoder with crossOrigin="anonymous" and reads frames
// back out of a canvas (filmstrips, thumbnails, the colour panel's histogram),
// so a response without CORS headers does not merely taint the canvas — the
// media fails to load at all. Presigned R2 URLs get this from the bucket's own
// CORS policy; going through the binding bypasses that, so it is served here.
//
// The allowance is "*" rather than the calling origin because echoing would
// need Vary: Origin, which splits the cache entry per origin and undoes the
// point of keying on the object. Nothing is given away by it: the token in the
// URL is already full access, and no credentials ride these requests.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers":
    "Content-Length, Content-Range, Accept-Ranges, ETag, Content-Disposition",
};

/** An attachment download is the same bytes with one more header, so the cached
 * entry stays the plain object and the header goes on the way out — the cache key
 * ignores the download name, and a stored Content-Disposition would otherwise
 * leak onto every later inline read of that object. */
function asDownload(res: Response, downloadName: string): Response {
  if (!downloadName) return res;
  const out = new Response(res.body, res);
  out.headers.set("Content-Disposition", contentDisposition(downloadName));
  return out;
}

function baseHeaders(object: R2Object, key: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  // Media is immutable — a new upload is a new key — so it is cached hard and
  // the token, not the cache, is what bounds access.
  //
  // An HLS playlist is the exception, and the only one: a ladder publishes its
  // low rungs first and then REWRITES master.m3u8 in place to add the rest.
  // Cached as immutable, the first version would be pinned at the edge for a
  // week and the later rungs would never be listed to anyone — a 4K share
  // silently capped at 720p. Playlists are a few hundred bytes, so a short life
  // costs nothing; the segments they name are where caching earns its keep.
  headers.set(
    "Cache-Control",
    key.endsWith(".m3u8")
      ? `public, max-age=${PLAYLIST_TTL_SECONDS}`
      : `public, max-age=${EDGE_TTL_SECONDS}, immutable`
  );
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return headers;
}

const refuse = (body: string, status: number) =>
  new Response(body, { status, headers: CORS_HEADERS });

/** What a valid token resolves to: the R2 key it grants, plus the two
 * presentation fields an object token may carry. */
interface Granted {
  key: string;
  downloadName: string;
  version: string;
}

/** A stray percent is a malformed request, not a fault: decoding throws, and an
 * uncaught throw here is a Cloudflare exception page counted against this
 * Worker's error rate instead of the 404 it should be. */
function decodePath(segments: string[]): string | null {
  try {
    return segments.map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
}

/**
 * Decide whether this URL may read an object, and which one.
 *
 * Two token shapes reach here. An object token addresses exactly one key and
 * carries its expiry and signature in the query string. A tree token addresses
 * anything under a signed prefix and rides in the path, because an HLS player
 * follows relative URIs out of a playlist and a query string does not survive
 * that hop (mediaCdn.ts explains the choice).
 */
async function authorize(url: URL, env: MediaEnv): Promise<Granted | Response> {
  const segments = url.pathname.replace(/^\/+/, "").split("/");
  if (!env.CUT_MEDIA_SIGNING_SECRET) return refuse("Not configured.", 500);

  if (segments[0] === TREE_PREFIX) {
    // /_t/<expires>/<depth>/<sig>/<key…>
    const expires = Number(segments[1]);
    const depth = Number(segments[2]);
    const sig = segments[3] ? decodeURIComponent(segments[3]) : "";
    const rest = segments.slice(4);
    if (
      !sig ||
      !Number.isFinite(expires) ||
      !Number.isInteger(depth) ||
      depth < 1 ||
      depth > rest.length
    ) {
      return refuse("Not found.", 404);
    }
    if (expires * 1000 < Date.now()) return refuse("Link expired.", 403);
    let decoded: string[];
    try {
      decoded = rest.map(decodeURIComponent);
    } catch {
      return refuse("Not found.", 404);
    }
    // The signature covers the prefix, and the key is the prefix plus whatever
    // the playlist pointed at — so a `..` that climbed back out of the tree
    // would still verify. Checked on the DECODED segments: `%2e%2e` reaches the
    // key as `..` and would walk straight past a check on the raw path.
    if (decoded.slice(depth).some((s) => s === ".." || s === ".")) {
      return refuse("Not found.", 404);
    }
    const prefix = decoded.slice(0, depth).join("/");
    const expected = await treeSignatureFor(env.CUT_MEDIA_SIGNING_SECRET, prefix, expires);
    if (!sameSignature(sig, expected)) return refuse("Forbidden.", 403);
    return { key: decoded.join("/"), downloadName: "", version: "" };
  }

  const key = decodePath(segments);
  const expires = Number(url.searchParams.get("e"));
  const sig = url.searchParams.get("s") ?? "";
  // Both are signed, so neither can be edited in after the fact. The name is
  // sanitized by the same rule that signed it, so the two agree by construction.
  const downloadName = mediaDownloadName(url.searchParams.get("d") ?? "");
  const version = url.searchParams.get("v") ?? "";
  if (!key || !sig || !Number.isFinite(expires)) return refuse("Not found.", 404);
  // Expiry first: an expired token is the ordinary case once a share is
  // revoked, and it costs nothing to answer.
  if (expires * 1000 < Date.now()) return refuse("Link expired.", 403);
  const expected = await signatureFor(
    env.CUT_MEDIA_SIGNING_SECRET,
    key,
    expires,
    downloadName,
    version
  );
  if (!sameSignature(sig, expected)) return refuse("Forbidden.", 403);
  return { key, downloadName, version };
}

export async function serveMedia(
  request: Request,
  env: MediaEnv,
  ctx: { waitUntil(p: Promise<unknown>): void }
): Promise<Response> {
  // A media element's ranged GET is not preflighted, but a fetch() carrying a
  // Range header is; answer it so either style of caller works.
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers") ?? "Range",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { ...CORS_HEADERS, Allow: "GET, HEAD, OPTIONS" },
    });
  }
  const url = new URL(request.url);
  const allowed = await authorize(url, env);
  if (allowed instanceof Response) return allowed;
  const { key, downloadName, version } = allowed;

  // The cache key is the object and its version, never the token: tokens rotate
  // and every viewer holds a different one, so keying on the full URL would mean
  // a miss per viewer per rotation. The version is what a rewritten object
  // changes — without it, a fixed key like a project's preview proxy would serve
  // its pre-edit bytes for the whole edge TTL. The stored entry is the whole
  // object; a Range on the lookup is what makes the cache answer 206 from it.
  // Built from the resolved key rather than the request path: a tree token
  // carries its expiry and signature in the path, and those rotate, so keying
  // on the path as it arrived would give every mint its own cache entry and
  // undo the collapse this whole scheme exists for.
  const cacheUrl =
    `${url.origin}/${key.split("/").map(encodeURIComponent).join("/")}` +
    (version ? `?v=${version}` : "");
  const storeKey = new Request(cacheUrl, { method: "GET" });
  const rangeHeader = request.headers.get("range");
  const lookupKey = rangeHeader
    ? new Request(cacheUrl, { method: "GET", headers: { Range: rangeHeader } })
    : storeKey;
  const cache = caches.default;
  const hit = await cache.match(lookupKey);
  if (hit) return asDownload(hit, downloadName);

  // The size is only needed to resolve a range; a whole-object request skips
  // this and reads it off the object it is already fetching.
  const head = rangeHeader ? await env.CUT_MEDIA.head(key) : null;
  if (rangeHeader && !head) return refuse("Not found.", 404);

  const range = parseRange(rangeHeader, head?.size ?? 0);
  if (range === "invalid") {
    return new Response("Range not satisfiable.", {
      status: 416,
      headers: { ...CORS_HEADERS, "Content-Range": `bytes */${head?.size ?? 0}` },
    });
  }
  const size = head?.size ?? 0;

  if (range) {
    // Serve the asked-for bytes from R2 and fill the cache behind the
    // response. Reading the whole object to slice it here would risk the
    // Worker's memory ceiling on exactly the large files that most need the
    // cache.
    const part = await env.CUT_MEDIA.get(key, {
      range: { offset: range.start, length: range.end - range.start + 1 },
    });
    if (!part) return refuse("Not found.", 404);
    const headers = baseHeaders(part, key);
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    if (size <= MAX_CACHEABLE_BYTES) ctx.waitUntil(fillCache(env, key, storeKey));
    return asDownload(new Response(part.body, { status: 206, headers }), downloadName);
  }

  const object = await env.CUT_MEDIA.get(key);
  if (!object || !object.body) return refuse("Not found.", 404);
  const headers = baseHeaders(object, key);
  headers.set("Content-Length", String(object.size));
  // The fill takes its own R2 read rather than a tee of this one, so the put
  // ingests at R2 speed while this stream goes at the client's pace — a tee
  // couples the two and buffers the difference in memory.
  if (object.size <= MAX_CACHEABLE_BYTES) ctx.waitUntil(fillCache(env, key, storeKey));
  return asDownload(new Response(object.body, { status: 200, headers }), downloadName);
}

/** Cache fills in flight in this isolate, keyed by the stored URL. A cold open
 * of a cut fires many ranged misses at the same object over one connection —
 * and one connection is one isolate — so a fill per miss pulled the whole
 * object from R2 once per miss. The duplicate pulls exhausted the isolate
 * mid-burst, which killed the 206 streams it was serving, and the racing puts
 * on one key aborted each other, so the cache stayed cold and the next open
 * repeated the storm. An entry clears when its fill settles; a fill that
 * failed simply runs again on the next miss, alone. */
const fillsInFlight = new Map<string, Promise<void>>();

/** Store the whole object, streamed, behind the response being served.
 * cache.put refuses a 206, so the stored entry is always the full 200 — which
 * is what lets later range requests be answered from it. Past Cloudflare's
 * ceiling the put would fail, so callers skip the fill and those objects
 * stream from R2 every time rather than breaking. */
function fillCache(env: MediaEnv, key: string, storeKey: Request): Promise<void> {
  const pending = fillsInFlight.get(storeKey.url);
  if (pending) return pending;
  const fill = (async () => {
    const cache = caches.default;
    // A miss can race in just after a finished fill emptied the map; the
    // lookup keeps that from pulling the whole object again.
    if (await cache.match(storeKey)) return;
    const whole = await env.CUT_MEDIA.get(key);
    if (!whole || !whole.body) return;
    const headers = baseHeaders(whole, key);
    headers.set("Content-Length", String(whole.size));
    await cache.put(storeKey, new Response(whole.body, { status: 200, headers }));
  })()
    .catch(() => {})
    .finally(() => fillsInFlight.delete(storeKey.url));
  fillsInFlight.set(storeKey.url, fill);
  return fill;
}
