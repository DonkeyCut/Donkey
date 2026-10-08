import { expect, test } from "bun:test";
import { paneResize } from "./previewPane";

/**
 * What the preview does when its pane changes size: a camera still at its fit
 * refits, so dragging the timeline panel grows or shrinks the picture live; a
 * camera the user zoomed or panned holds its place.
 */

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

test("an untouched camera refits when the pane changes size", () => {
  // The timeline panel shrank: the pane got taller.
  expect(paneResize(rect(0, 0, 900, 500), rect(0, 0, 900, 700), { atFit: true, centeredX: true })).toEqual({ refit: true });
});

test("an untouched camera does not refit on a pure move", () => {
  expect(paneResize(rect(0, 0, 900, 500), rect(0, 10, 900, 500), { atFit: true, centeredX: true })).toEqual({ refit: false, dx: 0, dy: -10 });
});

test("a zoomed or panned camera holds its screen position", () => {
  const out = paneResize(rect(0, 0, 900, 500), rect(100, 0, 800, 700), { atFit: false, centeredX: false });
  expect(out).toEqual({ refit: false, dx: -50, dy: -100 });
  // A horizontally centered camera follows the pane's center across.
  expect(paneResize(rect(0, 0, 900, 500), rect(100, 0, 800, 700), { atFit: false, centeredX: true })).toEqual({ refit: false, dx: 0, dy: -100 });
});
