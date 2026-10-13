import { describe, expect, test } from "bun:test";
import { maskComposite } from "./mask";

describe("a mask over a shadowed element", () => {
  test("the cut is drawn with no shadow, whatever the canvas was left carrying", () => {
    // A text element with a drop shadow leaves the shadow set on the canvas.
    // Browsers shadow a destination-in draw too, so a cut that inherits it
    // fades the letters to the shadow's opacity wherever the mask keeps them
    // (skia-canvas doesn't, so the state at the draw is what's checked).
    const state = { shadowColor: "rgba(0,0,0,0.55)", shadowBlur: 30, shadowOffsetX: 0, shadowOffsetY: 8 };
    const stack: (typeof state)[] = [];
    let atDraw: typeof state | null = null;
    const ctx = {
      ...state,
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      save() {
        stack.push({ shadowColor: this.shadowColor, shadowBlur: this.shadowBlur, shadowOffsetX: this.shadowOffsetX, shadowOffsetY: this.shadowOffsetY });
      },
      restore() {
        Object.assign(this, stack.pop());
      },
      setTransform() {},
      drawImage() {
        atDraw = { shadowColor: this.shadowColor, shadowBlur: this.shadowBlur, shadowOffsetX: this.shadowOffsetX, shadowOffsetY: this.shadowOffsetY };
      },
    };
    maskComposite(ctx as unknown as CanvasRenderingContext2D, {} as CanvasImageSource);
    expect(atDraw).not.toBeNull();
    const s = atDraw!;
    expect(s.shadowColor === "transparent" || (s.shadowBlur === 0 && s.shadowOffsetX === 0 && s.shadowOffsetY === 0)).toBe(true);
    // The element's own shadow comes back for whatever paints next.
    expect(ctx.shadowColor).toBe("rgba(0,0,0,0.55)");
  });
});
