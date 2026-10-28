import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseFramesAt } from "./baseFrame";
import { registerBlobFile } from "./backend/browser/registry";
import { setFrameSinkFactory, type FrameSinkOptions } from "./mediaRead";

// A plain H.264 clip from the starter project's own footage, the kind of file the
// reported decoder failures came from.
const CLIP = join(dirname(fileURLToPath(import.meta.url)), "../../../public/cut-starter/media/recap-01-6a6c904b.mp4");
const url = registerBlobFile("test/base-frames.mp4", new File([readFileSync(CLIP)], "clip.mp4", { type: "video/mp4" }));

const frameAt = (t: number) => ({ canvas: {}, timestamp: t, duration: 1 / 24 });

/** A decoder whose hardware session dies after `good` frames, the way a
 * machine's decoder says only "Decoding error."; software always decodes. */
function dyingHardware(good: number, error: () => Error, opened: FrameSinkOptions[]) {
  setFrameSinkFactory((_track, _size, opts) => {
    opened.push(opts ?? {});
    return {
      getCanvas: async (t: number) => frameAt(t),
      canvases: async function* () {},
      canvasesAtTimestamps: async function* (times: Iterable<number> | AsyncIterable<number>) {
        let n = 0;
        for await (const t of times) {
          if (!opts?.software && n++ >= good) throw error();
          yield frameAt(t);
        }
      },
    } as never;
  });
}

afterAll(() => setFrameSinkFactory(null));

describe("baseFramesAt", () => {
  test("a decoder failure goes on in software from the frame it failed on", async () => {
    const opened: FrameSinkOptions[] = [];
    dyingHardware(1, () => new DOMException("Decoding error.", "EncodingError"), opened);

    const got: number[] = [];
    for await (const frame of baseFramesAt(url, [0, 1, 2])) got.push(frame!.timestamp);

    expect(got).toEqual([0, 1, 2]);
    expect(opened.map((o) => !!o.software)).toEqual([false, true]);
  });

  test("a failure that is not the decoder's ends the read", async () => {
    const opened: FrameSinkOptions[] = [];
    dyingHardware(0, () => new Error("network gone"), opened);

    const read = async () => {
      const frames = baseFramesAt(url, [0, 1]);
      while (!(await frames.next()).done) {
        // drain
      }
    };

    await expect(read()).rejects.toThrow("network gone");
    expect(opened).toHaveLength(1);
  });
});
