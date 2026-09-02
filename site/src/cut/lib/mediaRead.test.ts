import { describe, expect, test } from "bun:test";
import { CHUNK_SIZE } from "./chunkCache";
import { urlParallelism } from "./mediaRead";

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
