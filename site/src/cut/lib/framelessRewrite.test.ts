import { afterAll, describe, expect, spyOn, test } from "bun:test";

import { stubModule } from "@/lib/testing/stubModule";
import { useEditor } from "./store";
import type { MediaAsset } from "./types";

// A stream that parses and decodes here — it passes decodable() — and still
// gives the filmstrip no frames: a file that opens on no keyframe. The
// converter's rewrite of it reads like any file.
const FRAMELESS = "stored:p1/clip.mp4";
const REWRITTEN = "clip-1.mp4";
const REWRITTEN_URL = `stored:p1/${REWRITTEN}`;

await stubModule<typeof import("./mediaRead")>("./mediaRead", import.meta.url, {
  withMedia: (async (_src: unknown, fn: (input: unknown) => Promise<unknown>) => fn({})) as never,
  videoTrackOf: (async () => ({})) as never,
  readMediaFileSize: async () => 1234,
});
await stubModule<typeof import("./baseFrame")>("./baseFrame", import.meta.url, {
  baseFramesAt: async function* (url: string, times: number[]) {
    if (url === FRAMELESS) return;
    for (let i = 0; i < times.length; i++) yield { canvas: {} } as never;
  },
});
await stubModule<typeof import("./raster")>("./raster", import.meta.url, {
  rasterCanvasToDataUrl: async () => "data:image/jpeg;base64,tile",
});
await stubModule<typeof import("./mediaProxy")>("./mediaProxy", import.meta.url, {
  ensureProxy: async () => {},
  awaitsCompat: async () => false,
});
await stubModule<typeof import("./mediaSync")>("./mediaSync", import.meta.url, {
  storedMediaUrl: async (projectId: string, fileName: string) => `stored:${projectId}/${fileName}`,
});

const { enrichAsset, stripFailedFor } = await import("./media");
const { setHostMediaStore } = await import("./mediaConvert");

// The project's converter, as a headless host installs it: every ask is
// recorded, and the rewrite lands beside the original.
const asks: { fileName: string; mode?: string }[] = [];
setHostMediaStore({
  async convert(_projectId, source, opts) {
    asks.push({ fileName: source.fileName, mode: opts.mode });
    return { fileName: REWRITTEN, reencoded: true, duration: 20, width: 64, height: 36 };
  },
  async drop() {},
});

// The stub frames are no pictures, so the scene probe behind the strip fails
// and reports; this case is about the strip.
const warn = spyOn(console, "warn").mockImplementation(() => {});
const error = spyOn(console, "error").mockImplementation(() => {});
afterAll(() => {
  setHostMediaStore(null);
  warn.mockRestore();
  error.mockRestore();
});

const clip = (extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id: "v1",
  fileName: "clip.mp4",
  name: "clip.mp4",
  type: "video",
  duration: 20,
  url: FRAMELESS,
  peaks: [],
  color: { matrix: "bt709", fullRange: false, bitDepth: 8, detected: "rec709", codec: "avc1" },
  ...extra,
});

const live = () => useEditor.getState().assets.find((a) => a.id === "v1");

/** Let the rewrite that runs behind the enrich land. */
async function settle(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
}

describe("a stream that decodes and gives the filmstrip no frames", () => {
  test("is re-encoded once a session, keeps its id, and builds its strip from the new file", async () => {
    useEditor.setState({ projectId: "p1", readOnly: false, playing: false, assets: [clip()] });

    await enrichAsset(clip());
    await settle(() => (live()?.thumbs?.length ?? 0) > 0);

    // One forced re-encode of the file the strip could not read.
    expect(asks).toEqual([{ fileName: "clip.mp4", mode: "reencode" }]);
    // The same asset, now on the rewrite, with a strip read off it.
    const after = live()!;
    expect(after.id).toBe("v1");
    expect(after.fileName).toBe(REWRITTEN);
    expect(after.url).toBe(REWRITTEN_URL);
    expect(after.thumbs?.length).toBeGreaterThan(0);
    expect(stripFailedFor("v1")).toBe(false);

    // The same asset reading no frames again this session is not sent back:
    // a file no converter can fix fails as unreadable once.
    useEditor.setState({ assets: [clip()] });
    await enrichAsset(clip());
    expect(asks).toHaveLength(1);
    expect(stripFailedFor("v1")).toBe(true);
  });
});
