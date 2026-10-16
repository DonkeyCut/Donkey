import { afterAll, expect, test } from "bun:test";

import { landDerived, liveAsset } from "./derivedWrites";
import { useEditor } from "./store";
import type { MediaAsset } from "./types";

// A project opening with this many clips lands a cached strip and a cached
// waveform for each: past fifty separate store writes, React refuses the next.
const CLIPS = 30;

const video = (i: number): MediaAsset => ({
  id: `v${i}`,
  fileName: `v${i}.mp4`,
  name: `v${i}`,
  type: "video",
  duration: 8,
  width: 1280,
  height: 720,
  url: `https://media.test/v${i}.mp4`,
});

// The page's idle callbacks, run when the test says the page went idle.
const idle: (() => void)[] = [];
const g = globalThis as { requestIdleCallback?: unknown };
const realIdle = g.requestIdleCallback;
g.requestIdleCallback = (fn: () => void) => idle.push(fn);

afterAll(() => {
  g.requestIdleCallback = realIdle;
});

const nextTask = () => new Promise((r) => setTimeout(r, 0));

test("strips and waveforms landing across tasks reach the store in one task", async () => {
  useEditor.setState({ assets: Array.from({ length: CLIPS }, (_, i) => video(i)), readOnly: false });
  let writes = 0;
  const stop = useEditor.subscribe(() => writes++);
  try {
    // Each cached read resolves in a task of its own, the way IndexedDB
    // answers them during a project open.
    for (let i = 0; i < CLIPS; i++) {
      landDerived(`v${i}`, { thumbs: [`t${i}`], thumbStep: 1 });
      await nextTask();
      landDerived(`v${i}`, { peaks: [i] });
      await nextTask();
    }

    // Nothing lands while the page is busy, but readers see what is queued.
    expect(writes).toBe(0);
    expect(liveAsset("v3")?.peaks).toEqual([3]);

    // One idle callback lands the lot.
    expect(idle.length).toBe(1);
    idle.splice(0).forEach((fn) => fn());
    expect(writes).toBeGreaterThan(0);
    const assets = useEditor.getState().assets;
    expect(assets.every((a, i) => a.thumbs?.[0] === `t${i}` && a.peaks?.[0] === i)).toBe(true);
  } finally {
    stop();
  }
});

test("a later patch to the same field wins", async () => {
  useEditor.setState({ assets: [{ ...video(0), peaks: [9] }], readOnly: false });
  landDerived("v0", { peaks: [1, 2] });
  landDerived("v0", { peaks: undefined });

  expect(idle.length).toBe(1);
  idle.splice(0).forEach((fn) => fn());

  expect(useEditor.getState().assets[0].peaks).toBeUndefined();
});
