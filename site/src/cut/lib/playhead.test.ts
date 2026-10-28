import { describe, expect, test } from "bun:test";
import { overlayLiveAt } from "./overlayLive";
import { stepFrame } from "./playhead";

// Paused, the arrow keys step the playhead a frame at a time. Summing 1/30
// lands a hair under the frame: 283 steps make 9.4333…32, and a title cut in
// at 283 / 30 would not show yet while the block under it already had.
describe("stepping the paused playhead a frame", () => {
  test("lands each step exactly on its frame", () => {
    let t = 0;
    for (let k = 1; k <= 300; k++) {
      t = stepFrame(t, 1);
      expect(t).toBe(k / 30);
    }
    for (let k = 299; k >= 0; k--) {
      t = stepFrame(t, -1);
      expect(t).toBe(k / 30);
    }
  });

  test("a title that starts on the frame stepped to is on screen", () => {
    let t = 0;
    for (let k = 0; k < 283; k++) t = stepFrame(t, 1);
    expect(overlayLiveAt({ start: 283 / 30, end: 9.9 }, t)).toBe(true);
    expect(overlayLiveAt({ start: 268 / 30, end: 283 / 30 }, t)).toBe(false);
  });

  test("a playhead between frames steps to the next frame its way", () => {
    expect(stepFrame(5.21, 1)).toBe(157 / 30);
    expect(stepFrame(5.21, -1)).toBe(156 / 30);
  });
});
