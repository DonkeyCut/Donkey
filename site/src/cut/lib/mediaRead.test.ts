import { describe, expect, test } from "bun:test";
import { CHUNK_SIZE } from "./chunkCache";
import { spsHooks, urlParallelism } from "./mediaRead";

/** The cache one reader is given by the memory budget on an ordinary machine. */
const READER_CACHE = 8 * 2 ** 20;

describe("read width", () => {
  test("cloud media reads several chunks at once", () => {
    // The width is the point of the branch: a source over a real network
    // overlaps its reads instead of waiting a round trip per chunk. Sized off
    // what a worker holds — its chunk — rather than the whole cache, which is
    // what left every source on the floor of two.
    expect(urlParallelism("https://media.donkeycut.com/cut/u1/a.mp4", READER_CACHE)).toBe(
      READER_CACHE / CHUNK_SIZE
    );
    expect(urlParallelism("https://media.donkeycut.com/cut/u1/a.mp4", READER_CACHE)).toBeGreaterThan(2);
  });

  test("a cache with room for one chunk still overlaps a pair", () => {
    expect(urlParallelism("https://media.donkeycut.com/cut/u1/a.mp4", CHUNK_SIZE)).toBe(2);
    expect(urlParallelism("https://media.donkeycut.com/cut/u1/a.mp4", 1024)).toBe(2);
  });

  test("the width never passes what the library will run", () => {
    expect(urlParallelism("https://media.donkeycut.com/cut/u1/a.mp4", 999 * 2 ** 20)).toBe(8);
  });

  test("this Mac's engine and any plain-http origin keep the pair", () => {
    expect(urlParallelism("http://127.0.0.1:41417/file?p=a.mp4", READER_CACHE)).toBe(2);
  });
});

describe("SPS color hooks", () => {
  // A page served without cross-origin isolation has no SharedArrayBuffer
  // global; the hooks run there for every HDR phone clip.
  test("retag an HEVC HLG description in a page without SharedArrayBuffer", () => {
    const hevc10hlg =
      "AQIgAAAAsAAAAAAAHvAA/P36+gAADwOgAAEAGEABDAH//wIgAAADALAAAAMAAAMAHhcCQKEAAQAqQgEBAiAAAAMAsAAAAwAAAwAeoBQgQcGO2IF7kWRS/8ufxP6wFqEiQSAQogABAAdEAcBy9FNk";
    const description = Uint8Array.from(atob(hevc10hlg), (c) => c.charCodeAt(0));
    const sab = Object.getOwnPropertyDescriptor(globalThis, "SharedArrayBuffer")!;
    delete (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer;
    try {
      const hooks = spsHooks({ primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false });
      const config = hooks.transformConfig!({ codec: "hvc1.2.4.L123.B0", description });
      expect(config.description).toBeDefined();
      expect(config.description).not.toEqual(description);
    } finally {
      Object.defineProperty(globalThis, "SharedArrayBuffer", sab);
    }
  });
});
