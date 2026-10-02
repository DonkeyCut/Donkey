import { describe, expect, test } from "bun:test";
import { diveView, DIVE_MAX_SCALE, slotReel } from "./dive";
import { evalOverlayAnim } from "./anim";

const frame = { width: 1080, height: 1920, scale: 1 };
const rest = { x: 0.5, y: 0.5 };
const still = { x: 0.5, y: 0.5, dx: 0, dy: 0, scale: 1, rotation: 0 };

describe("slot reels", () => {
  test("every character in sight is a real character of the target's kind", () => {
    for (const ch of ["A", "z", "7"]) {
      for (let i = 0; i < 40; i++) {
        for (let roll = 0; roll <= 5; roll += 0.13) {
          for (const r of slotReel(ch, i, roll)) {
            expect(r.ch.length).toBe(1);
            if (ch === "7") expect(r.ch).toMatch(/[0-9]/);
            else if (ch === "A") expect(r.ch).toMatch(/[A-Z]/);
            else expect(r.ch).toMatch(/[a-z]/);
          }
        }
      }
    }
  });

  test("a landed reel shows the character alone, and a space never rolls", () => {
    expect(slotReel("Q", 3, 0)).toEqual([{ ch: "Q", y: 0, alpha: 1 }]);
    expect(slotReel(" ", 3, 2.5)).toEqual([{ ch: " ", y: 0, alpha: 1 }]);
  });
});

describe("dive", () => {
  const focus = { x: 120, y: 30, r: 24 };

  test("at rest the view is the identity", () => {
    const v = diveView(0, focus, still, rest, frame);
    expect(v.s).toBe(1);
    expect(v.tx).toBe(v.fx);
    expect(v.ty).toBe(v.fy);
  });

  test("landed, the ink around the focus reaches every corner from the frame's center", () => {
    const v = diveView(1, focus, still, rest, frame);
    expect(v.tx).toBeCloseTo(540, 6);
    expect(v.ty).toBeCloseTo(960, 6);
    expect(v.s * focus.r).toBeGreaterThanOrEqual(Math.hypot(540, 960));
    expect(v.s).toBeLessThanOrEqual(DIVE_MAX_SCALE);
  });

  test("a posed element lands its focus on the frame's center through the pose", () => {
    const pose = { x: 0.3, y: 0.7, dx: 10, dy: -20, scale: 1.5, rotation: 30 };
    const v = diveView(1, focus, pose, rest, frame);
    const cx = rest.x * frame.width;
    const cy = rest.y * frame.height;
    // P(t): the pose applied to the view's target.
    const th = (pose.rotation * Math.PI) / 180;
    const ux = v.tx - cx;
    const uy = v.ty - cy;
    const X = pose.x * frame.width + pose.dx + pose.scale * (Math.cos(th) * ux - Math.sin(th) * uy);
    const Y = pose.y * frame.height + pose.dy + pose.scale * (Math.sin(th) * ux + Math.cos(th) * uy);
    expect(X).toBeCloseTo(540, 6);
    expect(Y).toBeCloseTo(960, 6);
  });

  test("an exit dives in across its ramp and an entrance pulls back out", () => {
    const out = { out: { style: "dive" as const, seconds: 1 } };
    expect(evalOverlayAnim(out, 2.001, 3).dive).toBeCloseTo(0, 2);
    expect(evalOverlayAnim(out, 2.5, 3).dive).toBeCloseTo(0.5, 1);
    expect(evalOverlayAnim(out, 3, 3).dive).toBeCloseTo(1, 6);
    const inn = { in: { style: "dive" as const, seconds: 1 } };
    expect(evalOverlayAnim(inn, 0, 3).dive).toBeCloseTo(1, 6);
    expect(evalOverlayAnim(inn, 0.999, 3).dive).toBeLessThan(0.01);
  });
});
