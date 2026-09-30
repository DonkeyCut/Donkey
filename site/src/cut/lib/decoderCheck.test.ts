import { afterAll, expect, test } from "bun:test";
import { decodeYcc } from "@donkeycut/effects-kit";
import { clearDecodePaths, decodePath } from "./decoderCheck";
import { setFrameSinkFactory, type FrameSinkOptions } from "./mediaRead";

// The H.264 fixture's four tiles, as code values on [0,1].
const TILES: Record<string, readonly [number, number, number]> = {
  "16,16": [135 / 255, 91 / 255, 157 / 255],
  "48,16": [113 / 255, 164 / 255, 97 / 255],
  "16,48": [124 / 255, 128 / 255, 128 / 255],
  "48,48": [206 / 255, 128 / 255, 128 / 255],
};

/** A decoder that draws through Rec.709 and honors the override's range
 * flag, the way a browser that follows the rewritten tags does. */
function honoringDecoder(opts?: FrameSinkOptions) {
  const fullRange = opts?.colorSpace?.fullRange ?? false;
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      getImageData: (x: number, y: number) => {
        const [yy, cb, cr] = TILES[`${x},${y}`];
        const rgb = decodeYcc({ matrix: "bt709", fullRange }, yy, cb, cr);
        return { data: new Uint8ClampedArray([...rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)), 255]) };
      },
    }),
  };
  const frame = { canvas, timestamp: 0, duration: 1 / 30 };
  return {
    getCanvas: async () => frame,
    canvases: async function* () {
      yield frame;
    },
    canvasesAtTimestamps: async function* () {
      yield frame;
    },
  };
}

afterAll(() => {
  setFrameSinkFactory(null);
  clearDecodePaths();
});

test("each range the override names is measured on its own", async () => {
  clearDecodePaths();
  setFrameSinkFactory((_track, _size, opts) => honoringDecoder(opts) as never);
  expect(await decodePath("webcodecs", false)).toEqual({ kind: "code", drawnMatrix: "bt709", drawnFullRange: false });
  // A full-range master is read under a full-range override; a decoder that
  // honors the flag draws full range, and the recipe has to say so.
  expect(await decodePath("webcodecs", true)).toEqual({ kind: "code", drawnMatrix: "bt709", drawnFullRange: true });
});
