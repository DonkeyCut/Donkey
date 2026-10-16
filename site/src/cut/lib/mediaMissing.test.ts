import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { stubModule } from "@/lib/testing/stubModule";
import { CloudMediaError } from "./chunkCache";
import { bindFailureSink } from "./report";
import { useEditor } from "./store";
import type { MediaAsset } from "./types";

// Every peaks read answers with whatever the case sets, and counts itself.
let failure: unknown = null;
let reads = 0;
await stubModule<typeof import("./mediaRead")>("./mediaRead", import.meta.url, {
  audioPeaks: async () => {
    reads++;
    if (failure) throw failure;
    return [0.5];
  },
});

// The browser store holds a ledger pin, and the bytes, for whatever file the
// case names.
let pinned = "";
await stubModule<typeof import("./mediaSync")>("./mediaSync", import.meta.url, {
  pendingUploadsFor: async () => (pinned ? [{ projectId: "p1", fileName: pinned }] : []) as never,
  localMediaUrl: async () => "blob:local",
  localMediaFile: async () => null,
});
const { enrichAsset, ensurePeaks, missingMediaFor, resumePendingUploads } = await import("./media");

const reported: Error[] = [];
bindFailureSink((error) => reported.push(error));

const warn = spyOn(console, "warn").mockImplementation(() => {});
const decoder = globalThis as { AudioDecoder?: unknown };
const hadDecoder = "AudioDecoder" in decoder;
decoder.AudioDecoder ??= class {};
afterAll(() => {
  warn.mockRestore();
  if (!hadDecoder) delete decoder.AudioDecoder;
});

let n = 0;
const audio = (extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id: `a${++n}`,
  fileName: `take-${n}.m4a`,
  name: `take-${n}.m4a`,
  type: "audio",
  duration: 10,
  url: `/api/cut-cloud/projects/p1/media/take-${n}.m4a`,
  ...extra,
});

beforeEach(() => {
  pinned = "";
  reads = 0;
  reported.length = 0;
  useEditor.setState({ projectId: "p1", playing: false });
});

describe("a cloud file that is gone", () => {
  test("marks the asset missing and reports nothing", async () => {
    failure = new CloudMediaError(404);
    const asset = audio();

    await ensurePeaks(asset);

    expect(missingMediaFor(asset.id)).toBe(true);
    expect(reported).toEqual([]);
  });

  test("is read once per session", async () => {
    failure = new CloudMediaError(404);
    const asset = audio();

    await enrichAsset(asset);
    await enrichAsset(asset);
    await ensurePeaks(asset);

    expect(reads).toBe(1);
  });

  test("still uploading is not missing", async () => {
    failure = new CloudMediaError(404);
    const asset = audio({ upload: { progress: 0.4, stored: true } });

    await ensurePeaks(asset);

    expect(missingMediaFor(asset.id)).toBe(false);
  });
});

describe("an upload this browser still holds", () => {
  test("resuming it reads the local bytes and clears the mark", async () => {
    // The open's sweep reads the cloud before the ledger re-marks the upload,
    // and finds nothing there yet.
    failure = new CloudMediaError(404);
    const asset = audio();
    useEditor.setState({ assets: [asset] });
    await enrichAsset(asset);
    expect(missingMediaFor(asset.id)).toBe(true);

    failure = null;
    pinned = asset.fileName;
    await resumePendingUploads("p1", { kind: "cloud" } as never);
    await new Promise((r) => setTimeout(r, 0));

    expect(missingMediaFor(asset.id)).toBe(false);
    expect(useEditor.getState().assets.find((a) => a.id === asset.id)?.peaks).toEqual([0.5]);
  });
});

describe("other read failures", () => {
  test("a read refused for want of a session is not reported", async () => {
    failure = new CloudMediaError(401);
    const asset = audio();

    await ensurePeaks(asset);

    expect(missingMediaFor(asset.id)).toBe(false);
    expect(reported).toEqual([]);
  });

  test("an undecodable file is reported against its stage", async () => {
    failure = new DOMException("Decoding error.", "EncodingError");
    const asset = audio();

    await ensurePeaks(asset);

    expect(missingMediaFor(asset.id)).toBe(false);
    expect(reported.map((e) => e.message)).toEqual([`[cut] peaks failed for ${asset.fileName}`]);
  });
});
