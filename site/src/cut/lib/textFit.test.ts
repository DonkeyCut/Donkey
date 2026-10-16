import { expect, test } from "bun:test";
import { cycleFaceAt } from "./textFit";
import type { TextOverlay } from "./types";

// The preview resolves a cycling title on every playback tick. One face at one
// frame width settles once: the same element comes back, so the tick neither
// re-wraps the title nor hands React a new element to render.

const title = {
  id: "t",
  kind: "text",
  text: "STAY TUNED FOR MORE",
  start: 0,
  end: 2,
  x: 0.5,
  y: 0.5,
  size: 60,
  font: "montserrat",
  weight: 700,
  color: "#ffffff",
  shadow: false,
  plate: false,
  anim: { fonts: { faces: [{ font: "anton", scale: 1.6 }, { font: "caveat" }], at: 0, seconds: 2, rate: 10 } },
} as TextOverlay;

test("a face settles once per frame width, and the next face settles on its own", () => {
  const first = cycleFaceAt(title, 0.01, 1080);
  expect(first.font).toBe("anton");
  expect(cycleFaceAt(title, 0.05, 1080)).toBe(first);
  const next = cycleFaceAt(title, 0.15, 1080);
  expect(next.font).toBe("caveat");
  expect(cycleFaceAt(title, 0.25, 1080)).toBe(first);
  expect(cycleFaceAt(title, 0.05, 540)).not.toBe(first);
});

test("outside the cycle the title comes back as it is", () => {
  expect(cycleFaceAt(title, 2.5, 1080)).toBe(title);
});
