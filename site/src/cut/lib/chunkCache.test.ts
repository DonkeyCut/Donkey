import { describe, expect, test } from "bun:test";
import {
  CHUNK_SIZE,
  ChunkMemory,
  chunkIdentity,
  chunkRuns,
  collect,
  decodeResident,
  encodeResident,
  routeMediaUrl,
  streamRun,
} from "./chunkCache";

const signed = (path: string, query = "e=123&s=abc") =>
  `https://media.donkeycut.com${path}?${query}`;

describe("chunkIdentity", () => {
  test("keys on the decoded path and drops the auth query", () => {
    const a = chunkIdentity(signed("/cut/u1/projects/p1/media/clip%201.mp4", "e=1&s=x"));
    const b = chunkIdentity(signed("/cut/u1/projects/p1/media/clip%201.mp4", "e=2&s=y"));
    expect(a?.key).toBe("/cut/u1/projects/p1/media/clip 1.mp4");
    expect(a?.keyHash).toBe(b!.keyHash);
    expect(a?.versionTag).toBe(b!.versionTag);
  });

  test("two versions of one object share a key and split on directory", () => {
    const a = chunkIdentity(signed("/cut/u1/projects/p1/preview.mp4", "e=1&s=x&v=100"));
    const b = chunkIdentity(signed("/cut/u1/projects/p1/preview.mp4", "e=1&s=x&v=200"));
    expect(a?.keyHash).toBe(b!.keyHash);
    expect(a?.versionTag).not.toBe(b!.versionTag);
  });

  test("an unversioned URL still lands somewhere stable", () => {
    const a = chunkIdentity(signed("/cut/u1/library/a.mp4", "e=1&s=x"));
    const b = chunkIdentity(signed("/cut/u1/library/a.mp4", "e=9&s=z"));
    expect(a?.version).toBe("");
    expect(a?.versionTag).toBe(b!.versionTag);
  });

  test("answers null off the media origin", () => {
    expect(chunkIdentity("https://example.com/cut/u1/library/a.mp4?e=1&s=x")).toBe(null);
    expect(chunkIdentity("http://localhost:41417/api/cut/projects/p/media/a.mp4")).toBe(null);
    expect(chunkIdentity("blob:https://donkeycut.com/xyz")).toBe(null);
    expect(chunkIdentity("not a url")).toBe(null);
  });

  test("answers null for tree-token paths", () => {
    expect(chunkIdentity(signed("/_t/123/2/sig/cut/u1/hls/master.m3u8"))).toBe(null);
  });

  test("distinct keys land in distinct directories", () => {
    const a = chunkIdentity(signed("/cut/u1/projects/p1/media/a.mp4"));
    const b = chunkIdentity(signed("/cut/u1/projects/p1/media/b.mp4"));
    expect(a?.keyHash).not.toBe(b?.keyHash);
    expect(/^[0-9a-f]{16}$/.test(a?.keyHash ?? "")).toBe(true);
    expect(/^[0-9a-f]{8}$/.test(a?.versionTag ?? "")).toBe(true);
  });
});

describe("routeMediaUrl", () => {
  const page = "https://donkeycut.com";

  test("takes the page's own media routes, relative or absolute", () => {
    expect(routeMediaUrl("/api/cut-cloud/projects/p1/media/a%20b.mp4", page)).toBe(
      "https://donkeycut.com/api/cut-cloud/projects/p1/media/a%20b.mp4"
    );
    expect(routeMediaUrl(`${page}/api/cut-cloud/library/media/a.mp4`, page)).toBe(
      `${page}/api/cut-cloud/library/media/a.mp4`
    );
  });

  test("takes a shared view's media route, so a viewer holds the file once", () => {
    // A share reads the owner's bytes through its token, and the route
    // redirects to the same media origin the owner's own route lands on.
    expect(routeMediaUrl("/api/cut-shared/tok3n/projects/p1/media/a.mp4", page)).toBe(
      `${page}/api/cut-shared/tok3n/projects/p1/media/a.mp4`
    );
  });

  test("answers null for anything that is not a route to media", () => {
    expect(routeMediaUrl("https://example.com/api/cut-cloud/projects/p1/media/a.mp4", page)).toBe(null);
    expect(routeMediaUrl("http://localhost:41417/api/cut/projects/p/media/a.mp4", page)).toBe(null);
    expect(routeMediaUrl(`${page}/api/cut-cloud/projects/p1`, page)).toBe(null);
    expect(routeMediaUrl(`${page}/api/cut-shared/tok3n/projects/p1`, page)).toBe(null);
    expect(routeMediaUrl("https://media.donkeycut.com/cut/u1/library/a.mp4?e=1&s=x", page)).toBe(null);
    expect(routeMediaUrl("/api/cut-cloud/projects/p1/media/a.mp4", "")).toBe(null);
  });
});

describe("ChunkMemory", () => {
  const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

  test("holds a chunk once for every reader and counts what it holds", () => {
    const m = new ChunkMemory(() => 10);
    m.remember("a", 0, bytes(4));
    m.remember("a", 0, bytes(4, 2));
    expect(m.held).toBe(4);
    expect(m.recall("a", 0)?.[0]).toBe(2);
    expect(m.recall("a", 1)).toBe(null);
    expect(m.recall("b", 0)).toBe(null);
  });

  test("lets the least recently touched chunk go at the cap", () => {
    const m = new ChunkMemory(() => 10);
    m.remember("a", 0, bytes(4));
    m.remember("a", 1, bytes(4));
    m.recall("a", 0);
    m.remember("a", 2, bytes(4));
    expect(m.held).toBe(8);
    expect(m.recall("a", 1)).toBe(null);
    expect(m.recall("a", 0)).not.toBe(null);
    expect(m.recall("a", 2)).not.toBe(null);
  });

  test("refuses a chunk larger than the whole cap", () => {
    const m = new ChunkMemory(() => 3);
    m.remember("a", 0, bytes(4));
    expect(m.held).toBe(0);
    expect(m.recall("a", 0)).toBe(null);
  });

  test("forgets a version whole and leaves the others", () => {
    const m = new ChunkMemory(() => 100);
    m.remember("k/v1", 0, bytes(4));
    m.remember("k/v1", 1, bytes(4));
    m.remember("k/v2", 0, bytes(4));
    m.forget("k/v1");
    expect(m.held).toBe(4);
    expect(m.recall("k/v1", 0)).toBe(null);
    expect(m.recall("k/v2", 0)).not.toBe(null);
  });
});

describe("chunkRuns", () => {
  test("groups consecutive indices into runs", () => {
    expect(chunkRuns([0, 1, 2, 5, 6, 9], 8)).toEqual([
      [0, 2],
      [5, 6],
      [9, 9],
    ]);
  });

  test("splits a long stretch at the cap", () => {
    expect(chunkRuns([0, 1, 2, 3, 4], 2)).toEqual([
      [0, 1],
      [2, 3],
      [4, 4],
    ]);
  });

  test("empty in, empty out", () => {
    expect(chunkRuns([], 8)).toEqual([]);
  });
});

describe("resident bitmap", () => {
  test("round-trips a sparse set", () => {
    const set = new Set([0, 1, 7, 8, 63, 100, 2999]);
    expect(decodeResident(encodeResident(set, 3000), 3000)).toEqual(set);
  });

  test("stays small for a long file", () => {
    const every = Array.from({ length: 3000 }, (_, i) => i);
    // A 6GB source is 3000 chunks; the map has to be cheap enough to write
    // beside the chunks rather than rescanning the directory on every open.
    expect(encodeResident(every, 3000).length).toBeLessThan(600);
  });

  test("drops indices past the count and survives junk", () => {
    expect(decodeResident(encodeResident([0, 5, 99], 8), 8)).toEqual(new Set([0, 5]));
    expect(decodeResident("!!not base64!!", 16).size).toBe(0);
    expect(decodeResident("", 16).size).toBe(0);
  });
});

test("chunk size divides the byte math cleanly", () => {
  expect(CHUNK_SIZE).toBe(2 * 1024 * 1024);
  expect(Number.isInteger(CHUNK_SIZE)).toBe(true);
});

const pattern = (from: number, len: number) => {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (from + i) % 251;
  return out;
};

/** A response whose body arrives in `piece`-sized writes, so a reader sees the
 * same partial deliveries a real link gives it. */
const streamed = (bytes: Uint8Array, piece: number): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += piece)
          controller.enqueue(bytes.subarray(at, Math.min(at + piece, bytes.length)));
        controller.close();
      },
    })
  );

/** A response with no body stream at all, the shape a cache or a polyfill hands
 * back, which both readers fall back to `arrayBuffer()` for. */
const whole = (bytes: Uint8Array): Response =>
  ({ body: null, arrayBuffer: async () => bytes.slice().buffer }) as unknown as Response;

/** The message a rejected read left behind, or "" when it resolved. */
const failure = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "";
  } catch (err) {
    return String(err);
  }
};

describe("streamRun", () => {
  const start = 2 * CHUNK_SIZE;
  const total = 2 * CHUNK_SIZE + 1024;
  const body = pattern(start, total);

  const run = async (res: Response, fromZero = false) => {
    const got: [number, Uint8Array][] = [];
    await streamRun(res, start, start + total - 1, fromZero, (i, b) => got.push([i, b]));
    return got;
  };

  test("hands each chunk over at its own boundary", async () => {
    const got = await run(streamed(body, 300_000));
    expect(got.map(([i, b]) => [i, b.length])).toEqual([
      [2, CHUNK_SIZE],
      [3, CHUNK_SIZE],
      [4, 1024],
    ]);
    expect(got[0][1]).toEqual(pattern(start, CHUNK_SIZE));
    expect(got[2][1]).toEqual(pattern(start + 2 * CHUNK_SIZE, 1024));
  });

  test("settles a chunk before the rest of the run arrives", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const res = new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(body.subarray(0, CHUNK_SIZE));
          await held;
          controller.enqueue(body.subarray(CHUNK_SIZE));
          controller.close();
        },
      })
    );
    const got: number[] = [];
    const done = streamRun(res, start, start + total - 1, false, (i) => got.push(i));
    while (!got.length) await new Promise((r) => setTimeout(r, 1));
    expect(got).toEqual([2]);
    release();
    await done;
    expect(got).toEqual([2, 3, 4]);
  });

  test("skips past the front when the server ignored the range", async () => {
    const got = await run(streamed(pattern(0, start + total), 500_000), true);
    expect(got.map(([i]) => i)).toEqual([2, 3, 4]);
    expect(got[0][1]).toEqual(pattern(start, CHUNK_SIZE));
  });

  test("reads a bodyless response the same way", async () => {
    const got = await run(whole(body));
    expect(got.map(([i, b]) => [i, b.length])).toEqual([
      [2, CHUNK_SIZE],
      [3, CHUNK_SIZE],
      [4, 1024],
    ]);
    expect(got[1][1]).toEqual(pattern(start + CHUNK_SIZE, CHUNK_SIZE));
  });

  test("throws when the body ends early", async () => {
    expect(await failure(run(streamed(body.subarray(0, total - 10), 300_000)))).toContain(
      "short range"
    );
    expect(await failure(run(whole(body.subarray(0, total - 10))))).toContain("short range");
  });
});

describe("collect", () => {
  test("holds only the bytes asked for", async () => {
    const body = pattern(0, 3 * CHUNK_SIZE);
    const out = await collect(streamed(body, 700_000), CHUNK_SIZE, 2 * CHUNK_SIZE - 1, true);
    expect(out).toEqual(pattern(CHUNK_SIZE, CHUNK_SIZE));
  });

  test("reads a ranged body from its own start", async () => {
    const out = await collect(streamed(pattern(1024, 4096), 1000), 1024, 1024 + 4095, false);
    expect(out).toEqual(pattern(1024, 4096));
  });

  test("throws when the body ends early", async () => {
    expect(await failure(collect(streamed(pattern(0, 100), 32), 0, 199, false))).toContain(
      "short range"
    );
  });
});
