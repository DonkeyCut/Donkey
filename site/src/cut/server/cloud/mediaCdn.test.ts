import { describe, expect, test } from "bun:test";

import { contentDisposition, mediaDownloadName } from "./mediaName";

process.env.CUT_MEDIA_SIGNING_SECRET = "test-media-signing-secret";
const {
  MEDIA_TREE_PREFIX,
  mediaObjectUrl,
  mediaSignature,
  mediaTreeSignature,
  mediaTreeUrl,
  mediaUrlLifetime,
} = await import("./mediaCdn");

const SECRET = "test-media-signing-secret";

/** The Worker's verifier, transcribed from worker/cf/media.ts. It runs on
 * WebCrypto rather than node:crypto, so the two implementations only agree if
 * the signed payload and its encoding match exactly — which is what this pins:
 * a drift between them 403s every cloud media read. */
async function workerSignature(
  secret: string,
  key: string,
  expires: number,
  downloadName: string,
  version: string
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(`${key}\n${expires}\n${downloadName}\n${version}`)
  );
  let binary = "";
  for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const KEY = "cut/user1/projects/p1/media/clip.mp4";

describe("signer and verifier agree", () => {
  test("across every field combination a URL can carry", async () => {
    const expires = 1_750_000_000;
    const cases: [string, string][] = [
      ["", ""], // plain read
      ["export.mp4", ""], // download
      ["", "1750000000000"], // versioned
      ["My Cut.mp4", "1750000000000"], // both
      ["夏の動画.mp4", "42"], // non-ASCII download name
    ];
    for (const [name, version] of cases) {
      expect(mediaSignature(SECRET, KEY, expires, name, version)).toBe(
        await workerSignature(SECRET, KEY, expires, name, version)
      );
    }
  });

  test("a differing field changes the signature", () => {
    const at = 1_750_000_000;
    const base = mediaSignature(SECRET, KEY, at, "", "");
    expect(mediaSignature(SECRET, KEY, at, "a.mp4", "")).not.toBe(base);
    expect(mediaSignature(SECRET, KEY, at, "", "2")).not.toBe(base);
    // The name and version fields cannot be slid past each other: a name that
    // ends where the version begins must not sign the same as the reverse.
    expect(mediaSignature(SECRET, KEY, at, "a", "b")).not.toBe(
      mediaSignature(SECRET, KEY, at, "", "a\nb")
    );
  });
});

describe("tokens are stable inside a window", () => {
  test("two mints of one object return the identical URL", () => {
    expect(mediaObjectUrl(KEY)).toBe(mediaObjectUrl(KEY));
  });

  test("a version reaches the query and changes the URL", () => {
    const a = new URL(mediaObjectUrl(KEY, { version: "1" }));
    expect(a.searchParams.get("v")).toBe("1");
    expect(mediaObjectUrl(KEY, { version: "2" })).not.toBe(mediaObjectUrl(KEY, { version: "1" }));
  });

  test("a download name reaches the query, sanitized", () => {
    const url = new URL(mediaObjectUrl(KEY, { downloadName: 'a"b\nc.mp4' }));
    expect(url.searchParams.get("d")).toBe("abc.mp4");
  });

  test("the lifetime clears docCache's ten-minute link-reuse floor", () => {
    // Below it, a stored media-links batch could never be reused and every
    // cloud project would open on origin URLs (lib/docCache.ts).
    expect(mediaUrlLifetime()).toBeGreaterThan(10 * 60);
  });

  test("a longer minimum lifetime still lands on a window boundary", () => {
    const day = 24 * 60 * 60;
    const a = mediaObjectUrl(KEY, { minLifetimeSeconds: day });
    expect(a).toBe(mediaObjectUrl(KEY, { minLifetimeSeconds: day }));
    expect(Number(new URL(a).searchParams.get("e"))).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + day
    );
  });
});

/** The Worker's tree verifier, transcribed from worker/cf/media.ts for the same
 * reason as the object one above. */
async function workerTreeSignature(
  secret: string,
  prefix: string,
  expires: number
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(`tree\n${prefix}\n${expires}`)
  );
  let binary = "";
  for (const byte of new Uint8Array(mac)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PREFIX = "cut/user1/projects/p1/hls/v1abc";

describe("tree tokens", () => {
  test("signer and verifier agree", async () => {
    const expires = 1_750_000_000;
    expect(mediaTreeSignature(SECRET, PREFIX, expires)).toBe(
      await workerTreeSignature(SECRET, PREFIX, expires)
    );
  });

  test("a tree signature is not an object signature", () => {
    const at = 1_750_000_000;
    // Framing them differently is what stops a token minted for a whole prefix
    // from being replayed as one for the single object at that path.
    expect(mediaTreeSignature(SECRET, PREFIX, at)).not.toBe(
      mediaSignature(SECRET, PREFIX, at, "", "")
    );
  });

  test("the URL carries the depth the Worker needs to recover the prefix", () => {
    const url = new URL(mediaTreeUrl(PREFIX, "master.m3u8"));
    const segments = url.pathname.replace(/^\/+/, "").split("/");
    expect(segments[0]).toBe(MEDIA_TREE_PREFIX);
    const depth = Number(segments[2]);
    expect(depth).toBe(PREFIX.split("/").length);
    expect(segments.slice(4, 4 + depth).join("/")).toBe(PREFIX);
    expect(segments.slice(4 + depth).join("/")).toBe("master.m3u8");
  });

  test("a relative hop from the playlist keeps the token", () => {
    // This is the whole reason the token is in the path: a player resolves
    // "720p/seg00001.ts" against the master's URL, and everything before the
    // last slash — token included — comes along.
    const master = mediaTreeUrl(PREFIX, "master.m3u8");
    const variant = new URL("720p/index.m3u8", master);
    const segment = new URL("seg00001.ts", variant);
    const token = new URL(master).pathname.split("/").slice(0, 5).join("/");
    expect(segment.pathname.startsWith(token)).toBe(true);
    expect(segment.pathname.endsWith(`${PREFIX}/720p/seg00001.ts`)).toBe(true);
  });

  test("no query string, so nothing is lost on that hop", () => {
    expect(new URL(mediaTreeUrl(PREFIX, "master.m3u8")).search).toBe("");
  });

  test("the hold is bounded, so a token is never an open-ended grant", () => {
    const week = 7 * 24 * 60 * 60;
    const expires = Number(
      new URL(mediaTreeUrl(PREFIX, "master.m3u8", { holdSeconds: week })).pathname.split("/")[2]
    );
    expect(expires).toBeLessThan(Math.floor(Date.now() / 1000) + week);
  });

  test("a long cut still gets a token that outlasts watching it", () => {
    const twoHours = 2 * 60 * 60;
    const expires = Number(
      new URL(mediaTreeUrl(PREFIX, "master.m3u8", { holdSeconds: twoHours })).pathname.split("/")[2]
    );
    expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000) + twoHours);
  });
});

describe("download names", () => {
  test("quotes and newlines come out", () => {
    expect(mediaDownloadName('a"b\r\nc')).toBe("abc");
  });

  test("a non-ASCII name gets both header forms", () => {
    const header = contentDisposition("夏の動画.mp4");
    // filename= must be a ByteString; the real name rides filename*.
    expect(header).toContain('filename="____.mp4"');
    expect(header).toContain("filename*=UTF-8''%E5%A4%8F");
    for (const ch of header) expect(ch.charCodeAt(0)).toBeLessThan(256);
  });

  test("a name with nothing ASCII left still names a file", () => {
    expect(contentDisposition("動画")).toContain('filename="__"');
  });
});
