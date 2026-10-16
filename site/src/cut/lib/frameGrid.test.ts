import { expect, test } from "bun:test";
import { heldFrames, holdOverlays, showsAt } from "./frameGrid";
import type { Overlay } from "./types";

const FPS = 30;
/** The output frame times a 30 fps export samples, frames 0..5. */
const frames = [0, 1, 2, 3, 4, 5].map((k) => k / FPS);

test("a footprint shorter than a frame holds the one at or after its start", () => {
  const [held] = heldFrames([{ start: 0.01, end: 0.01 + 1 / 60 }], FPS);
  expect(held).toMatchObject({ first: 1, last: 2 });
  expect(frames.filter((t) => showsAt(0.01, 0.01 + 1 / 60, held, t))).toEqual([1 / FPS]);
});

test("a run of flash frames lands one per output frame, and the next clip waits its turn", () => {
  const items = [0, 1, 2].map((k) => ({ start: k / 60, end: (k + 1) / 60 }));
  items.push({ start: 3 / 60, end: 4 });
  const held = heldFrames(items, FPS);
  expect(held.map((h) => h && [h.first, h.last])).toEqual([null, [1, 2], [2, 3], [3, 120]]);
  frames.forEach((t, k) => {
    const live = items.filter((it, i) => showsAt(it.start, it.end, held[i], t));
    expect(live).toHaveLength(1);
    expect(items.indexOf(live[0])).toBe(Math.min(k, 3));
  });
});

test("footprints that hold their own frames are left as they are", () => {
  expect(heldFrames([{ start: 0, end: 1 }, { start: 1, end: 1 + 1 / 60 }, { start: 2, end: 3 }], 60)).toEqual([
    null,
    null,
    null,
  ]);
});

test("a sub-frame title widens onto its frame and the title after it moves off it", () => {
  const title = (id: string, start: number, end: number): Overlay =>
    ({ id, kind: "text", text: id, start, end, x: 0.5, y: 0.5 }) as Overlay;
  const overlays = [title("a", 0.01, 0.01 + 1 / 60), title("b", 0.01 + 1 / 60, 1), title("c", 0.5, 0.6)];
  overlays[2].lane = 1;
  const held = holdOverlays(overlays, FPS);
  expect(held[0]).toMatchObject({ start: 0.01, end: 1.5 / FPS });
  expect(held[1]).toMatchObject({ start: 1.5 / FPS, end: 1 });
  expect(held[2]).toBe(overlays[2]);
});
