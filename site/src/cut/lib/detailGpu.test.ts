import { afterAll, afterEach, expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import { memoryUsage } from "./memoryBudget";

// A stand-in WebGL2 context: constants read as their own names, calls are
// recorded, and the allocation calls hand back fresh objects.
const allocations: { internal: string; w: number; h: number }[] = [];
let deleted = 0;
const gl = new Proxy({} as Record<string, unknown>, {
  get(_t, key: string) {
    if (/^[A-Z0-9_]+$/.test(key)) return key;
    if (key === "texImage2D")
      return (_target: unknown, _level: number, internal: string, w: unknown, h: unknown) => {
        if (typeof w === "number") allocations.push({ internal, w, h: h as number });
      };
    if (key === "deleteTexture") return () => void deleted++;
    if (key === "isContextLost") return () => false;
    if (key.startsWith("get") && key.endsWith("Parameter")) return () => true;
    if (key === "getExtension") return () => ({ loseContext() {} });
    if (key.startsWith("create") || key.startsWith("get")) return () => ({});
    return () => {};
  },
});
const canvas = { width: 2, height: 2, getContext: () => gl };
await stubModule<typeof import("./raster")>("./raster", import.meta.url, {
  createRasterCanvas: (() => canvas) as never,
});
const { applyDetailGpu, detailGpuBytes, DETAIL_IDLE_MS, disposeDetailGpu, releaseDetailGpu } = await import("./detailGpu");
// The pass is a module singleton. A file that ran first without WebGL left
// it marked unavailable, so this one starts from a fresh build; files after
// this one build their own.
disposeDetailGpu();
afterAll(disposeDetailGpu);

afterEach(() => {
  releaseDetailGpu();
  allocations.length = 0;
  deleted = 0;
});

test("a 4K frame's detail buffers are one and two float channels, reported to the budget", () => {
  const w = 3840;
  const h = 2160;
  expect(applyDetailGpu({} as CanvasImageSource, w, h, { sharpen: 40, clarity: 40 })).not.toBeNull();
  const full = allocations.filter((a) => a.w === w);
  const half = allocations.filter((a) => a.w === w / 2);
  expect(full.map((a) => a.internal)).toEqual(["R32F", "R32F", "R32F"]);
  expect(half.map((a) => a.internal).sort()).toEqual(["RG16F", "RG32F", "RG32F", "RG32F", "RG32F", "RG32F"]);
  const px = w * h;
  const expected = px * 4 * 2 + px * 4 * 3 + (px / 4) * (8 * 5 + 4);
  expect(detailGpuBytes()).toBe(expected);
  // Well under the 530MB four-channel float buffers held before.
  expect(detailGpuBytes()).toBeLessThan(260 * 2 ** 20);
  expect(memoryUsage().canvases).toBeGreaterThanOrEqual(expected);
});

test("detail left idle lets its buffers go, and comes back on the next frame", () => {
  const realNow = performance.now.bind(performance);
  const realSet = globalThis.setTimeout;
  let now = 1000;
  const timers: (() => void)[] = [];
  performance.now = () => now;
  globalThis.setTimeout = ((fn: () => void) => {
    timers.push(fn);
    return timers.length;
  }) as unknown as typeof setTimeout;
  try {
    applyDetailGpu({} as CanvasImageSource, 1920, 1080, { sharpen: 30 });
    expect(detailGpuBytes()).toBeGreaterThan(0);
    // Used again inside the window: the check re-arms and holds on.
    now += DETAIL_IDLE_MS / 2;
    applyDetailGpu({} as CanvasImageSource, 1920, 1080, { sharpen: 30 });
    now += DETAIL_IDLE_MS / 2;
    timers.shift()!();
    expect(detailGpuBytes()).toBeGreaterThan(0);
    now += DETAIL_IDLE_MS;
    timers.shift()!();
    // What stays is the one-pixel canvas the programs draw into.
    expect(detailGpuBytes()).toBeLessThanOrEqual(4);
    expect(deleted).toBe(3);
    applyDetailGpu({} as CanvasImageSource, 1920, 1080, { sharpen: 30 });
    expect(detailGpuBytes()).toBeGreaterThan(0);
    // Disposed with the preview, the pass holds nothing at all.
    disposeDetailGpu();
    expect(detailGpuBytes()).toBe(0);
  } finally {
    performance.now = realNow;
    globalThis.setTimeout = realSet;
  }
});
