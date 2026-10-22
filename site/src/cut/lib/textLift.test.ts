import { expect, test } from "bun:test";
import { setRasterFactory, type RasterFactory } from "./raster";
import { textLineLift } from "./textFit";

// The preview sets a title's lines in CSS line boxes; the export's painter
// sets them from textBaseline "middle". The two put the baseline in different
// places under a line's middle, so a Jost title turned -90 in five columns
// showed in the preview 12 px to the right of where the export drew it.
//
// Chrome's own numbers for Jost 700 at 110 px, read off its canvas: the
// face's line ascent and descent (what a CSS line box centres), and the
// ascent of "Hg" measured from the alphabetic and from the middle baseline.
const JOST_110 = { ascent: 118, descent: 41, alphabetic: 77, middle: 50.546875 };

/** A canvas reporting a face's metrics the way a browser's does. The
 * measurer keeps the first canvas it is handed, so the one canvas is what
 * each test re-reads. */
const reading = { lineMetrics: true };
const ctx = {
  font: "",
  letterSpacing: "0px",
  textBaseline: "alphabetic" as CanvasTextBaseline,
  measureText(text: string) {
    return {
      width: text.length * 60,
      actualBoundingBoxAscent: this.textBaseline === "middle" ? JOST_110.middle : JOST_110.alphabetic,
      ...(reading.lineMetrics
        ? { fontBoundingBoxAscent: JOST_110.ascent, fontBoundingBoxDescent: JOST_110.descent }
        : {}),
    };
  },
};
setRasterFactory({ createCanvas: () => ({ getContext: () => ctx }) } as unknown as RasterFactory);

test("a title's lines sit where the painter sets them", () => {
  // A CSS line box centres the face's ascent and descent, which leaves the
  // baseline half their difference under the line's middle.
  const cssDrop = (JOST_110.ascent - JOST_110.descent) / 2;
  // The painter's baseline sits under its middle by the gap between the two
  // alignments' ascents.
  const painterDrop = JOST_110.alphabetic - JOST_110.middle;
  const lift = textLineLift('700 110px "Jost"');
  expect(cssDrop - lift).toBeCloseTo(painterDrop, 6);
  // The offset the turned columns showed on a 1920 frame.
  expect(lift).toBeCloseTo(12.05, 2);
});

test("a canvas that cannot read a face's line metrics lifts nothing", () => {
  reading.lineMetrics = false;
  expect(textLineLift('700 109px "Jost"')).toBe(0);
});
