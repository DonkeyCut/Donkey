import { describe, expect, test } from "bun:test";

import { contentDisposition, mediaDownloadName } from "./mediaName";

process.env.CUT_MEDIA_SIGNING_SECRET = "test-media-signing-secret";
const { mediaObjectUrl, mediaSignature, mediaUrlLifetime } = await import("./mediaCdn");

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
