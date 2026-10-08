import { afterEach, describe, expect, mock, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import type { CutBackend } from "./backend/types";
import type { MediaAsset } from "./types";

let features = new Set<string>();
await stubModule("./api", import.meta.url, {
  engineFeatures: async () => features as ReadonlySet<string>,
});
await stubModule("./mediaSync", import.meta.url, {
  storedMediaUrl: async (projectId: string, fileName: string) => `stored:${projectId}/${fileName}`,
});
let storedReads = true;
await stubModule<typeof import("./mediaRead")>("./mediaRead", import.meta.url, {
  probeMediaFile: (async () => {
    if (!storedReads) throw new Error("gone");
    return { hasVideo: true };
  }) as never,
});
const { ensureProxy, needsProxy, proxyUnreadable, useProxyJobs } = await import("./mediaProxy");
const { useEditor } = await import("./store");

const prores = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  fileName: `${id}.MOV`,
  name: `${id}.MOV`,
  type: "video",
  duration: 4,
  url: `https://example.test/${id}.MOV`,
  color: { matrix: "bt2020nc", fullRange: false, bitDepth: 10, detected: "apple-log", codec: "apch" },
  ...extra,
});

function backend(kind: CutBackend["kind"], answer: (path: string, body: unknown) => Response) {
  const calls: { path: string; body: unknown }[] = [];
  const fetch = mock(async (path: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    return answer(path, body);
  });
  return { api: { kind, caps: {}, fetch, url: (p: string) => p } as unknown as CutBackend, calls };
}

afterEach(() => {
  useProxyJobs.setState({ jobs: {} });
  useEditor.setState({ projectId: null, assets: [], readOnly: false });
});

describe("needsProxy", () => {
  test("a ProRes video without a proxy needs one; everything else does not", () => {
    expect(needsProxy(prores("a"))).toBe(true);
    expect(needsProxy(prores("a", { proxy: { fileName: "a.proxy.mp4", sizeBytes: 1 } }))).toBe(false);
    expect(needsProxy(prores("a", { color: { matrix: "bt709", fullRange: false, bitDepth: 8, detected: "rec709", codec: "avc1" } }))).toBe(false);
    expect(needsProxy(prores("a", { color: undefined }))).toBe(false);
    expect(needsProxy(prores("a", { type: "audio" }))).toBe(false);
  });
});

describe("ensureProxy", () => {
  test("a Mac project asks its engine and writes the proxy onto the asset", async () => {
    features = new Set(["media.proxy"]);
    const asset = prores("a");
    useEditor.setState({ projectId: "p", assets: [asset] });
    const b = backend("local", () => Response.json({ fileName: "a.proxy.mp4", sizeBytes: 321, width: 64, height: 64 }));
    await ensureProxy("p", asset, b.api);
    expect(b.calls[0].path).toBe("/api/cut/projects/p/proxy");
    const body = b.calls[0].body as { file: string; maxHeight: number; crf: number };
    expect(body.file).toBe("a.MOV");
    expect(body.maxHeight).toBeGreaterThan(0);
    expect(body.crf).toBeGreaterThanOrEqual(0);
    const after = useEditor.getState().assets[0];
    expect(after.proxy).toEqual({ fileName: "a.proxy.mp4", sizeBytes: 321 });
    expect(after.proxyUrl).toBe("stored:p/a.proxy.mp4");
    expect(useProxyJobs.getState().jobs.a).toBeUndefined();
  });

  test("an engine without the route makes none, and the panel is told", async () => {
    features = new Set();
    const asset = prores("a");
    useEditor.setState({ projectId: "p", assets: [asset] });
    const b = backend("local", () => Response.json({}));
    await ensureProxy("p", asset, b.api);
    expect(b.calls).toHaveLength(0);
    expect(useEditor.getState().assets[0].proxy).toBeUndefined();
    expect(useProxyJobs.getState().jobs.a).toEqual({ kind: "none" });
  });

  test("a cloud project takes a proxy the worker already built", async () => {
    const asset = prores("a");
    useEditor.setState({ projectId: "p", assets: [asset] });
    const b = backend("cloud", () => Response.json({ fileName: "a.proxy.mp4", sizeBytes: 9 }));
    await ensureProxy("p", asset, b.api);
    expect(b.calls[0]).toEqual({ path: "/api/cut/projects/p/proxy", body: { file: "a.MOV" } });
    expect(useEditor.getState().assets[0].proxy).toEqual({ fileName: "a.proxy.mp4", sizeBytes: 9 });
  });

  test("a failure leaves the asset on the master and says why", async () => {
    features = new Set(["media.proxy"]);
    const asset = prores("a");
    useEditor.setState({ projectId: "p", assets: [asset] });
    const b = backend("local", () => Response.json({ error: "ffmpeg fell over" }, { status: 500 }));
    await ensureProxy("p", asset, b.api);
    expect(useEditor.getState().assets[0].proxy).toBeUndefined();
    expect(useProxyJobs.getState().jobs.a).toEqual({ kind: "failed", error: "ffmpeg fell over" });
  });

  test("an asset still uploading, or one with a proxy, is left alone", async () => {
    features = new Set(["media.proxy"]);
    const b = backend("local", () => Response.json({}));
    await ensureProxy("p", prores("a", { upload: { progress: 0.5 } }), b.api);
    await ensureProxy("p", prores("b", { proxy: { fileName: "b.proxy.mp4", sizeBytes: 1 } }), b.api);
    expect(b.calls).toHaveLength(0);
  });
});

describe("proxyUnreadable", () => {
  // A doc can name a proxy whose file is not there (a copy made before
  // proxies travelled, a file lost from storage). The reader that failed to
  // open it hands it here: the asset drops back to the master at once, and
  // the project heals it once.
  const broken = (id: string) =>
    prores(id, { proxy: { fileName: `${id}.proxy.mp4`, sizeBytes: 3 }, proxyUrl: `https://example.test/${id}.proxy.mp4` });

  test("a proxy whose file is gone comes off the asset and is made again", async () => {
    features = new Set(["media.proxy"]);
    storedReads = false;
    const asset = broken("gone");
    useEditor.setState({ projectId: "p", assets: [asset] });
    const b = backend("local", () => Response.json({ fileName: "gone.proxy.mp4", sizeBytes: 44 }));
    const healed = proxyUnreadable(asset, b.api);
    // The master plays from the moment the reader gives up.
    expect(useEditor.getState().assets[0].proxy).toBeUndefined();
    expect(useEditor.getState().assets[0].proxyUrl).toBeUndefined();
    await healed;
    expect(b.calls[0].path).toBe("/api/cut/projects/p/proxy");
    expect(useEditor.getState().assets[0].proxy).toEqual({ fileName: "gone.proxy.mp4", sizeBytes: 44 });
    storedReads = true;
  });

  test("a proxy that still reads comes back under a fresh address, unbuilt", async () => {
    storedReads = true;
    const asset = broken("lapsed");
    useEditor.setState({ projectId: "p", assets: [asset] });
    const b = backend("local", () => Response.json({}));
    await proxyUnreadable(asset, b.api);
    expect(b.calls).toHaveLength(0);
    expect(useEditor.getState().assets[0].proxy).toEqual(asset.proxy!);
    expect(useEditor.getState().assets[0].proxyUrl).toBe("stored:p/lapsed.proxy.mp4");
  });

  test("heals once a session: a second failure leaves the master playing", async () => {
    storedReads = true;
    const asset = broken("twice");
    useEditor.setState({ projectId: "p", assets: [asset] });
    const b = backend("local", () => Response.json({}));
    await proxyUnreadable(asset, b.api);
    const back = useEditor.getState().assets[0];
    await proxyUnreadable(back, b.api);
    expect(useEditor.getState().assets[0].proxy).toBeUndefined();
  });

  test("a shared view drops the proxy for itself and builds nothing", async () => {
    const asset = broken("viewer");
    useEditor.setState({ projectId: "p", assets: [asset], readOnly: true });
    const b = backend("local", () => Response.json({}));
    await proxyUnreadable(asset, b.api);
    expect(useEditor.getState().assets[0].proxyUrl).toBeUndefined();
    expect(b.calls).toHaveLength(0);
  });
});

describe("the in-page proxy's muxer", () => {
  // The page writes the proxy to disk while it encodes. What it holds between
  // writes is one chunk, whatever the master's length, and the header it
  // reserved up front makes the finished file read from its start.
  test("streams the file out a bounded chunk at a time and reads back", async () => {
    const { EncodedPacket, EncodedVideoPacketSource, Input, BufferSource, MP4 } = await import("mediabunny");
    const { PROXY_WRITE_CHUNK, proxyOutput, proxyPacketBudget } = await import("./proxyEncode");
    const file = new Uint8Array(64 * 1024 * 1024);
    let size = 0;
    let written = 0;
    let largestWrite = 0;
    const writable = new WritableStream<{ type: "write"; data: Uint8Array; position: number }>({
      write(chunk) {
        file.set(chunk.data, chunk.position);
        size = Math.max(size, chunk.position + chunk.data.byteLength);
        written += chunk.data.byteLength;
        largestWrite = Math.max(largestWrite, chunk.data.byteLength);
      },
    });
    const frames = 240;
    const frameBytes = 128 * 1024;
    const output = proxyOutput(writable);
    const source = new EncodedVideoPacketSource("vp9");
    output.addVideoTrack(source, { maximumPacketCount: proxyPacketBudget(frames, 8, 0).video });
    await output.start();
    let writtenMidway = 0;
    for (let i = 0; i < frames; i++) {
      const packet = new EncodedPacket(new Uint8Array(frameBytes).fill(i & 0xff), i === 0 ? "key" : "delta", i / 30, 1 / 30);
      await source.add(packet, i === 0 ? { decoderConfig: { codec: "vp09.02.51.10", codedWidth: 64, codedHeight: 64 } } : undefined);
      if (i === frames / 2) writtenMidway = written;
    }
    await output.finalize();
    // Half the frames in, most of their bytes are already on disk.
    expect(writtenMidway).toBeGreaterThan((frames / 2) * frameBytes - 2 * PROXY_WRITE_CHUNK);
    expect(largestWrite).toBeLessThanOrEqual(PROXY_WRITE_CHUNK);
    const input = new Input({ source: new BufferSource(file.slice(0, size).buffer), formats: [MP4] });
    const track = await input.getPrimaryVideoTrack();
    expect(track).not.toBeNull();
    expect((await track!.computePacketStats()).packetCount).toBe(frames);
    // Fast start: the header sits ahead of the media.
    const text = new TextDecoder("latin1").decode(file.slice(0, 64 * 1024));
    expect(text.indexOf("moov")).toBeGreaterThan(-1);
    expect(text.indexOf("moov")).toBeLessThan(text.indexOf("mdat"));
  });
});
