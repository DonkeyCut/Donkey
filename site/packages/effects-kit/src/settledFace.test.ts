import { expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { withFontCycle } from "./fontCycle";
import { renderElementCanvas, type RenderEnv } from "./render";
import type { TextOverlay } from "./types";

// A cycling title is painted every frame it is on screen. Its face is settled
// onto the title's own lines once per face, on one measuring canvas: a frame
// that paints it opens only the canvas it draws on.

const title: TextOverlay = {
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
  anim: { fonts: { faces: [{ font: "anton", scale: 1.6 }], at: 0, seconds: 2, rate: 10 } },
};

test("painting a cycling title again opens no canvas beyond the one it draws on", async () => {
  let made = 0;
  const env: RenderEnv = {
    fontStack: () => "Arial",
    createCanvas: (w, h) => {
      made++;
      return new Canvas(w, h) as unknown as HTMLCanvasElement;
    },
  };
  const face = withFontCycle(title, 0.5);
  await renderElementCanvas(face, 270, 480, env);
  const counts: number[] = [];
  for (let i = 0; i < 3; i++) {
    made = 0;
    await renderElementCanvas(withFontCycle(title, 0.5 + i * 0.01), 270, 480, env);
    counts.push(made);
  }
  made = 0;
  await renderElementCanvas({ ...title, anim: undefined }, 270, 480, env);
  const plain = made;
  expect(counts).toEqual([plain, plain, plain]);
});
