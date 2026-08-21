import { describe, expect, test } from "bun:test";
import {
  CHUNK_SIZE,
  chunkIdentity,
  chunkRuns,
  decodeResident,
  encodeResident,
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
