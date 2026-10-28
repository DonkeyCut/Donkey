import { afterAll, describe, expect, spyOn, test } from "bun:test";

import { stubModule } from "@/lib/testing/stubModule";
import { bindFailureSink } from "./report";
import { useEditor } from "./store";
import type { MediaAsset } from "./types";
import { UserError } from "./userError";

// A stream this page turns out not to decode once it tries: HEVC in Firefox
// refuses the strip's track, a malformed MP3 track fails the waveform's
// decoder. The file is fine; the page hands the stream to a compat proxy.

await stubModule<typeof import("./mediaRead")>("./mediaRead", import.meta.url, {
  withMedia: (async (_src: unknown, fn: (input: unknown) => Promise<unknown>) => fn({})) as never,
  videoTrackOf: (async () => null) as never,
  audioPeaks: (async () => {
    throw new DOMException("Decoding error. (malformed stream: mpa: invalid packet length)", "EncodingError");
  }) as never,
});
await stubModule<typeof import("./baseFrame")>("./baseFrame", import.meta.url, {
  // eslint-disable-next-line require-yield
  baseFramesAt: async function* () {
    throw new UserError("media_no_readable_video", "This file has no readable video.");
  },
});
// Each proxy ask, with the cover the asset needed when it was made.
const { compatNeedOf } = await import("./codecSupport");
const asks: string[] = [];
await stubModule<typeof import("./mediaProxy")>("./mediaProxy", import.meta.url, {
  ensureProxy: async (_projectId: string, asset: MediaAsset) => {
    asks.push(`${asset.id}:${await compatNeedOf(asset)}`);
  },
  awaitsCompat: async () => false,
});

const { enrichAsset, stripFailedFor } = await import("./media");

const reports: string[] = [];
bindFailureSink((error) => reports.push(error.message));
const warn = spyOn(console, "warn").mockImplementation(() => {});
const decoder = (globalThis as { AudioDecoder?: unknown }).AudioDecoder;
(globalThis as { AudioDecoder?: unknown }).AudioDecoder = class {};
afterAll(() => {
  bindFailureSink((error) => console.error(error));
  warn.mockRestore();
  (globalThis as { AudioDecoder?: unknown }).AudioDecoder = decoder;
});

const asset = (extra: Partial<MediaAsset>): MediaAsset => ({
  id: "a",
  fileName: "clip.mp4",
  name: "clip.mp4",
  type: "video",
  duration: 9,
  url: "stored:p1/clip.mp4",
  ...extra,
});

describe("a stream this page cannot decode", () => {
  test("a filmstrip that finds no readable video asks for a compat proxy", async () => {
    const tiktok = asset({ id: "v1", peaks: [] });
    useEditor.setState({ projectId: "p1", readOnly: false, playing: false, assets: [tiktok] });

    await enrichAsset(tiktok);
    await Promise.resolve();

    expect(asks.at(-1)).toBe("v1:video");
    expect(reports).toEqual([]);
    expect(stripFailedFor("v1")).toBe(false);
  });

  test("a waveform whose decoder fails asks for a compat proxy, once", async () => {
    const recording = asset({ id: "s1", type: "audio", fileName: "bandicam.mp3", name: "bandicam.mp3" });
    useEditor.setState({ projectId: "p1", assets: [recording] });

    await enrichAsset(recording);
    await Promise.resolve();
    expect(asks.at(-1)).toBe("s1:audio");
    expect(reports).toEqual([]);

    // The same stream failing again is the file's own failure.
    await enrichAsset(recording);
    expect(reports).toEqual(["[cut] enrich failed for bandicam.mp3 (audio, 9s)"]);
  });
});
