import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mediaSignature } from "../../server/cloud/mediaCdn";
import { serveMedia, type MediaEnv } from "./media";

// serveMedia runs against the Workers globals; the tests stand in for the two
// it touches — caches.default and the R2 binding — with in-memory fakes that
// count every whole-object read, which is the quantity the single-flight fill
// exists to bound. A cold open really does fire a dozen ranged misses at one
// object at once (five decoders probing head and tail, then their retries),
// and before the fill was single-flighted each miss pulled the whole object.

const SECRET = "test-secret";
const KEY = "cut/user/projects/p1/media/IMG_TEST.MOV";
const SIZE = 256 * 1024;

const BYTES = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) BYTES[i] = i & 0xff;

const tick = () => new Promise((r) => setTimeout(r, 5));

function makeEnv() {
  const counts = { whole: 0, ranged: 0 };
  const r2Object = (offset = 0, length = SIZE - offset) => ({
    body: new Response(BYTES.slice(offset, offset + length)).body,
    size: SIZE,
    httpEtag: '"test-etag"',
    httpMetadata: { contentType: "video/quicktime" },
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", "video/quicktime");
    },
  });
  const env: MediaEnv = {
    CUT_MEDIA_SIGNING_SECRET: SECRET,
    CUT_MEDIA: {
      head: async (key: string) => (key === KEY ? r2Object() : null),
      get: async (key: string, opts?: { range?: { offset: number; length?: number } }) => {
        if (key !== KEY) return null;
        if (opts?.range) {
          counts.ranged++;
          return r2Object(opts.range.offset, opts.range.length);
        }
        counts.whole++;
        await tick(); // hold the read open so concurrent misses overlap it
        return r2Object();
      },
    },
  } as unknown as MediaEnv;
  return { env, counts };
}

/** caches.default, reduced to what serveMedia uses: whole entries stored under
 * the request URL, and — like the real edge — nothing stored until a put has
 * consumed its body to the end. Ranged lookups miss, which keeps every test
 * request on the R2 path where the fill behavior lives. */
function makeCaches() {
  const store = new Map<string, { headers: [string, string][]; body: Uint8Array }>();
  return {
    store,
    default: {
      async match(req: Request) {
        if (req.headers.get("range")) return undefined;
        const hit = store.get(req.url);
        if (!hit) return undefined;
        return new Response(hit.body.slice(), { status: 200, headers: hit.headers });
      },
      async put(req: Request, res: Response) {
        const body = new Uint8Array(await res.arrayBuffer());
        store.set(req.url, { headers: [...res.headers.entries()], body });
      },
    },
  };
}

function signedUrl(): string {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const sig = mediaSignature(SECRET, KEY, expires);
  const path = KEY.split("/").map(encodeURIComponent).join("/");
  return `https://media.example.com/${path}?e=${expires}&s=${encodeURIComponent(sig)}`;
}

let fakeCaches: ReturnType<typeof makeCaches>;
const realCaches = (globalThis as { caches?: unknown }).caches;

beforeEach(() => {
  fakeCaches = makeCaches();
  (globalThis as { caches?: unknown }).caches = fakeCaches;
});

afterEach(() => {
  (globalThis as { caches?: unknown }).caches = realCaches;
});

function makeCtx() {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    ctx: { waitUntil: (p: Promise<unknown>) => void waits.push(p) },
  };
}

const request = (range?: string) =>
  new Request(signedUrl(), { headers: range ? { Range: range } : undefined });

describe("serveMedia cold-cache fill", () => {
  test("a burst of ranged misses serves every range and fills once", async () => {
    const { env, counts } = makeEnv();
    const { ctx, waits } = makeCtx();
    const tail = SIZE - 4096;
    const ranges = [
      "bytes=0-",
      "bytes=0-",
      "bytes=0-",
      "bytes=0-",
      "bytes=0-",
      `bytes=${tail}-`,
      `bytes=${tail}-`,
      `bytes=${tail}-`,
      "bytes=1000-1999",
      "bytes=8192-16383",
      "bytes=0-511",
      `bytes=${SIZE - 1}-`,
    ];
    const responses = await Promise.all(
      ranges.map((range) => serveMedia(request(range), env, ctx))
    );

    for (let i = 0; i < ranges.length; i++) {
      const res = responses[i];
      expect(res.status).toBe(206);
      const m = /^bytes=(\d+)-(\d*)$/.exec(ranges[i])!;
      const start = Number(m[1]);
      const end = m[2] === "" ? SIZE - 1 : Number(m[2]);
      expect(res.headers.get("Content-Range")).toBe(`bytes ${start}-${end}/${SIZE}`);
      const body = new Uint8Array(await res.arrayBuffer());
      expect(body).toEqual(BYTES.slice(start, end + 1));
    }

    await Promise.all(waits);
    // The whole point: twelve misses, one whole-object pull.
    expect(counts.whole).toBe(1);
    expect(counts.ranged).toBe(ranges.length);
    expect(fakeCaches.store.size).toBe(1);
    const [stored] = fakeCaches.store.values();
    expect(stored.body).toEqual(BYTES);
  });

  test("a miss arriving after the fill finished reads the cache, not R2", async () => {
    const { env, counts } = makeEnv();
    const first = makeCtx();
    await serveMedia(request("bytes=0-1023"), env, first.ctx);
    await Promise.all(first.waits);
    expect(counts.whole).toBe(1);

    // The lookup missed (ranged), the fill map is empty again — only the
    // stored-entry check keeps this from pulling the whole object anew.
    const second = makeCtx();
    const res = await serveMedia(request("bytes=2048-4095"), env, second.ctx);
    expect(res.status).toBe(206);
    await Promise.all(second.waits);
    expect(counts.whole).toBe(1);
  });

  test("concurrent whole-object reads each stream, with one shared fill", async () => {
    const { env, counts } = makeEnv();
    const { ctx, waits } = makeCtx();
    const responses = await Promise.all([
      serveMedia(request(), env, ctx),
      serveMedia(request(), env, ctx),
      serveMedia(request(), env, ctx),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    }
    await Promise.all(waits);
    // Three reads served the three responses; the fill added at most one more.
    expect(counts.whole).toBe(4);
    expect(fakeCaches.store.size).toBe(1);
  });
});
