import { describe, expect, test } from "bun:test";
import { setRasterFactory } from "./raster";
import { cutRenderEnv } from "./textRender";
import type { MediaAsset } from "./types";

// A sticker this big costs about seven megabytes decoded, so two of them fill
// the share the stickers hold at the test ceiling and a third pushes one out.
const SIDE = 1300;

let decodes = 0;
setRasterFactory({
  createCanvas: () => {
    throw new Error("The sticker cache draws nothing.");
  },
  decodeImage: async () => {
    decodes++;
    return { source: {} as CanvasImageSource, width: SIDE, height: SIDE };
  },
  canvasToBlob: async () => new Blob(),
});

globalThis.fetch = (async () => new Response(new Blob())) as typeof fetch;

const assets = ["a1", "a2", "a3"].map(
  (id) => ({ id, url: `https://media.donkeycut.com/cut/u1/library/${id}.png` }) as MediaAsset
);
const resolve = (id: string) => cutRenderEnv(assets).resolveAsset!(id);

describe("the sticker cache", () => {
  test("holds what it has room for and drops what nothing has asked for", async () => {
    await resolve("a1");
    await resolve("a2");
    expect(decodes).toBe(2);

    // A sticker already decoded is handed back without decoding it again,
    // which is what a render asking every frame depends on.
    await resolve("a2");
    expect(decodes).toBe(2);

    // The third is past the share: the one nothing has asked for since goes.
    await resolve("a3");
    expect(decodes).toBe(3);
    await resolve("a3");
    await resolve("a2");
    expect(decodes).toBe(3);

    // The dropped one decodes again the moment something reaches for it.
    await resolve("a1");
    expect(decodes).toBe(4);
  });
});
