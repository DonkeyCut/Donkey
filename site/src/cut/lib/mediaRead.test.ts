import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { stubModule } from "@/lib/testing/stubModule";
import { CHUNK_SIZE } from "./chunkCache";
import { hasUndecodableVideo, probeMediaFile, readMediaFileSize, spsHooks, UnreadableMediaError, urlParallelism, videoTrackOf } from "./mediaRead";

/** What the stubbed browser decodes; each test sets it. */
let decodes = { h264: true, aac: true };
await stubModule<typeof import("./codecSupport")>("./codecSupport", import.meta.url, {
  browserCodecs: async () => decodes,
});

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

describe("decodability", () => {
  test("a track whose header mediabunny can't parse reads as undecodable", async () => {
    // A corrupt SPS throws from inside canDecode ("Invalid exponential-Golomb
    // code."): the track exists, and no decoder here can open it.
    const track = { canDecode: async () => { throw new Error("Invalid exponential-Golomb code."); }, codec: "avc" };
    const input = { getPrimaryVideoTrack: async () => track } as never;
    // A page: the decodability gate only runs where something plays.
    const doc = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { value: {}, configurable: true });
    try {
      expect(await videoTrackOf(input)).toBeNull();
      expect(await hasUndecodableVideo(input)).toBe(true);
    } finally {
      if (doc) Object.defineProperty(globalThis, "document", doc);
      else delete (globalThis as { document?: unknown }).document;
    }
  });
});

describe("H.264 in a browser without it", () => {
  // Firefox on Linux without the system's codecs decodes no H.264 at all. The
  // footage imports as it is, from its header, and a compat proxy carries its
  // picture (mediaProxy.ts); a converter would only write H.264 again.
  const h264 = () => {
    const bytes = execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=s=64x48:r=10:d=0.5",
      "-c:v", "libx264", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov", "pipe:1",
    ]);
    return new Blob([new Uint8Array(bytes)], { type: "video/mp4" });
  };

  // A page with no WebCodecs of its own: the stubbed codec list is the only
  // answer, whatever decoder stand-in another test file left on the global.
  const asPage = async <T>(run: () => Promise<T>): Promise<T> => {
    const doc = Object.getOwnPropertyDescriptor(globalThis, "document");
    const decoder = Object.getOwnPropertyDescriptor(globalThis, "VideoDecoder");
    Object.defineProperty(globalThis, "document", { value: {}, configurable: true });
    delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
    try {
      return await run();
    } finally {
      if (doc) Object.defineProperty(globalThis, "document", doc);
      else delete (globalThis as { document?: unknown }).document;
      if (decoder) Object.defineProperty(globalThis, "VideoDecoder", decoder);
    }
  };

  test("imports from its header with its picture's size", async () => {
    decodes = { h264: false, aac: true };
    const probe = await asPage(() => probeMediaFile(h264()));
    expect(probe).toMatchObject({ hasVideo: true, width: 64, height: 48 });
  });

  test("a browser that has H.264 and still cannot open the track converts it", async () => {
    decodes = { h264: true, aac: true };
    const err = await asPage(() => probeMediaFile(h264())).catch((e: unknown) => e);
    expect(err instanceof UnreadableMediaError && err.undecodable).toBe(true);
  });
});

describe("unparseable containers", () => {
  test("a container this page can't parse goes to a converter", async () => {
    // ffmpeg on this Mac or in the cloud reads far more containers than the
    // page's demuxers, so the import hands the file on.
    const err = await probeMediaFile(new Blob([new Uint8Array(4096).fill(7)])).catch((e: unknown) => e);

    expect(err instanceof UnreadableMediaError && err.undecodable).toBe(true);
  });
});

describe("url reads", () => {
  // HTTP statuses a media server answers for a file that is gone, or a range
  // past the end of one that is empty.
  const NOT_FOUND = 404;
  const RANGE_NOT_SATISFIABLE = 416;

  for (const status of [NOT_FOUND, RANGE_NOT_SATISFIABLE]) {
    test(`a ${status} comes back named, once`, async () => {
      let asked = 0;
      const real = globalThis.fetch;
      globalThis.fetch = (async () => {
        asked++;
        return new Response(null, { status });
      }) as unknown as typeof fetch;
      try {
        const err = await readMediaFileSize("https://files.example.com/a.mp4").catch((e: unknown) => e);

        expect((err as Error).name).toBe("MediaFetchError");
        expect((err as Error).message).toContain(String(status));
        expect(asked).toBe(1);
      } finally {
        globalThis.fetch = real;
      }
    });
  }
});
