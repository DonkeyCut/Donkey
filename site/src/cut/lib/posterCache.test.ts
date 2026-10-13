import { describe, expect, test } from "bun:test";
import { noteStageDraw, posterStillWanted, stageDrawMark } from "./posterCache";

/** The opening poster stands in only until the stage draws. A cut that opens
 * on a gap draws an all-black frame, and reading the canvas for a picture
 * took that for "nothing yet": the poster — a frame from elsewhere in the cut
 * — was painted over the true opening and stayed until the next redraw. */

describe("the opening poster", () => {
  test("is wanted while the stage has drawn nothing since the open", () => {
    const mark = stageDrawMark();
    expect(posterStillWanted(mark)).toBe(true);
  });

  test("is dropped once the stage draws, even a frame with no picture in it", () => {
    const mark = stageDrawMark();
    noteStageDraw();
    expect(posterStillWanted(mark)).toBe(false);
  });
});
