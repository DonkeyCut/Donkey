import { describe, expect, test } from "bun:test";
import { decodeOverrideFor } from "./decoderCheck";
import { ClipReader, renderFile } from "./exportRender";
import { FrameSourcePool } from "./frameSource";
import { sourceLookup } from "./lutBuild";
import { colorRead, fileAt, previewFile, sameColorRead } from "./sourceColor";
import type { MediaAsset } from "./types";

const HLG = { matrix: "bt2020nc", fullRange: false, bitDepth: 10, detected: "hlg", codec: "hvc1" } as const;

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: "a",
  fileName: "a.mov",
  name: "a",
  type: "video",
  duration: 10,
  url: "https://media.test/a.mov",
  color: { ...HLG },
  ...over,
});

describe("colorRead", () => {
  test("a proxy is read as tagged, as Rec.709 limited, with the master's meaning", () => {
    const read = colorRead(asset(), "proxy");
    expect(read.colorSpace).toBeUndefined();
    expect(read.recipe()).toEqual({ profile: "hlg", matrix: "bt709", fullRange: false, drawnMatrix: "bt709", drawnFullRange: false });
  });

  test("an HLG master is read through the override at its own range", () => {
    const full = asset({ color: { ...HLG, fullRange: true } });
    const read = colorRead(full, "master");
    expect(read.colorSpace).toEqual(decodeOverrideFor("webcodecs", true));
    expect(read.recipe()).toMatchObject({ profile: "hlg", matrix: "bt2020nc", fullRange: true });
  });

  test("the file a URL names", () => {
    const withProxy = asset({ proxyUrl: "https://media.test/a.proxy.mp4" });
    expect(fileAt(withProxy, withProxy.proxyUrl!)).toBe("proxy");
    expect(fileAt(withProxy, withProxy.url)).toBe("master");
    expect(previewFile(withProxy)).toBe("proxy");
    expect(previewFile(asset())).toBe("master");
  });

  test("a Rec.709 record reads the picture an unprobed asset draws; an HLG one does not", () => {
    const rec709 = { color: { matrix: "bt709", fullRange: false, bitDepth: 8, detected: "rec709", codec: "avc1" } } as const;
    expect(sameColorRead({}, rec709, "master")).toBe(true);
    expect(sameColorRead({}, { color: { ...HLG } }, "master")).toBe(false);
    expect(sameColorRead({ color: { ...HLG } }, { color: { ...HLG } }, "proxy")).toBe(true);
  });
});

describe("a render reads the master, and draws it through the master's recipe", () => {
  test("even when the asset has a proxy", () => {
    const a = asset({ proxyUrl: "https://media.test/a.proxy.mp4" });
    const reader = new ClipReader(a, () => a.url);
    // The reader decodes the master through the override …
    expect(reader.colorRead.colorSpace).toEqual(decodeOverrideFor("webcodecs", false));
    // … and the compositor's recipe describes that read, never the proxy's.
    const recipe = sourceLookup([a], renderFile)({ assetId: a.id });
    expect(recipe).toEqual(reader.colorRead.recipe());
    expect(recipe).toMatchObject({ matrix: "bt2020nc" });
  });
});

describe("the preview's source and its recipe name the same file", () => {
  test("a source reports the read it decodes with, and follows a color that lands later", () => {
    const pool = new FrameSourcePool(4);
    pool.beginFrame();
    const unprobed = asset({ color: undefined });
    const src = pool.get("k", unprobed, 480);
    expect(src.colorRead.colorSpace).toBeUndefined();
    // The header is read after the source opened: the decode tag changes,
    // and the source takes the new record.
    const probed = asset();
    pool.get("k", probed, 480);
    expect(src.colorRead.colorSpace).toEqual(decodeOverrideFor("webcodecs", false));
    expect(pool.peek("k", 480)).toBe(src);
  });

  test("a source on the proxy is read as the proxy", () => {
    const pool = new FrameSourcePool(4);
    pool.beginFrame();
    const src = pool.get("k", asset({ proxyUrl: "https://media.test/a.proxy.mp4" }), 480);
    expect(src.file).toBe("proxy");
    expect(src.colorRead.colorSpace).toBeUndefined();
  });
});
