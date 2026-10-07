import { describe, expect, test } from "bun:test";
import {
  cameraPoint,
  capStreak,
  composeCamera,
  REST_CAMERA,
  shiftCamera,
  STREAK_MAX,
  STREAK_MIN,
  STREAK_TAPS_MAX,
  streakTaps,
  worldPoint,
  MOTION_BLUR_FRAME,
} from "./camera";
import { EASE_IDS, easeAt } from "./ease";
import { elementLook } from "./elementFx";
import { cameraAt, evalOverlayFrame, isOverlayAnimated, poseAt, type OverlayKey } from "./keys";

const el = (over: Record<string, unknown> = {}) => ({ start: 0, end: 4, x: 0.5, y: 0.5, ...over });
const key = (t: number, over: Partial<OverlayKey> = {}): OverlayKey => ({
  t,
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  opacity: 1,
  ...over,
});
const state = (x: number, y: number) => ({ x, y, dx: 0, dy: 0, scale: 1, rotation: 0, opacity: 1 });

describe("easing presets", () => {
  test("every curve starts at 0 and lands on 1", () => {
    for (const id of EASE_IDS) {
      expect(easeAt(id, 0)).toBeCloseTo(0, 9);
      expect(easeAt(id, 1)).toBeCloseTo(1, 9);
    }
  });

  test("every curve only moves forward", () => {
    for (const id of EASE_IDS) {
      let last = -1;
      for (let i = 0; i <= 50; i++) {
        const v = easeAt(id, i / 50);
        expect(v).toBeGreaterThanOrEqual(last - 1e-12);
        last = v;
      }
    }
  });

  test("in starts slow, out starts fast, in-out passes the middle at the middle", () => {
    expect(easeAt("power2.in", 0.25)).toBeCloseTo(0.0625);
    expect(easeAt("power3.out", 0.25)).toBeGreaterThan(0.5);
    for (const id of ["sine.inOut", "power2.inOut", "power3.inOut"] as const) {
      expect(easeAt(id, 0.5)).toBeCloseTo(0.5);
      expect(easeAt(id, 0.25) + easeAt(id, 0.75)).toBeCloseTo(1);
    }
    expect(easeAt(undefined, 0.3)).toBeCloseTo(0.3);
  });

  test("a key's ease shapes the pose out of it", () => {
    const o = el({ kf: [key(0, { x: 0.2, ease: "power2.in" }), key(2, { x: 0.6 })] });
    expect(poseAt(o, 1).x).toBeCloseTo(0.2 + 0.4 * 0.25);
    const linear = el({ kf: [key(0, { x: 0.2 }), key(2, { x: 0.6 })] });
    expect(poseAt(linear, 1).x).toBeCloseTo(0.4);
  });
});

describe("camera composition", () => {
  test("the camera at rest changes nothing", () => {
    const s = { ...state(0.3, 0.7), dx: 5, dy: -2, scale: 1.5, rotation: 12 };
    expect(composeCamera(s, REST_CAMERA, 16 / 9)).toEqual(s);
  });

  test("a push centers the point it looks at and spreads the rest from it", () => {
    const cam = { x: 0.25, y: 0.3, scale: 2, rotation: 0 };
    const at = composeCamera(state(0.25, 0.3), cam, 16 / 9);
    expect(at.x).toBeCloseTo(0.5);
    expect(at.y).toBeCloseTo(0.5);
    expect(at.scale).toBeCloseTo(2);
    const beside = composeCamera(state(0.35, 0.3), cam, 16 / 9);
    expect(beside.x).toBeCloseTo(0.5 + 0.2);
  });

  test("a roll turns the board rigidly on a wide frame", () => {
    const aspect = 16 / 9;
    const cam = { x: 0.5, y: 0.5, scale: 1, rotation: 90 };
    // A point right of center, by a frame height's worth of pixels, swings
    // to below center by the same pixels.
    const p = composeCamera({ ...state(0.5 + 0.2 / aspect, 0.5), dx: 10, dy: 0 }, cam, aspect);
    expect(p.x).toBeCloseTo(0.5);
    expect(p.y).toBeCloseTo(0.7);
    expect(p.rotation).toBeCloseTo(90);
    // The preset's travel turns with the world.
    expect(p.dx).toBeCloseTo(0);
    expect(p.dy).toBeCloseTo(10);
  });

  test("the element's own pose composes inside the camera", () => {
    const cam = { x: 0.4, y: 0.6, scale: 1.5, rotation: 30 };
    const own = { ...state(0.2, 0.8), scale: 2, rotation: 15 };
    const c = composeCamera(own, cam, 1);
    expect(c.scale).toBeCloseTo(3);
    expect(c.rotation).toBeCloseTo(45);
    const back = worldPoint(cam, c.x, c.y, 1);
    expect(back.x).toBeCloseTo(0.2);
    expect(back.y).toBeCloseTo(0.8);
  });

  test("screen and world points invert each other at any aspect", () => {
    const cam = { x: 0.62, y: 0.41, scale: 2.7, rotation: -37 };
    for (const aspect of [9 / 16, 1, 16 / 9]) {
      const s = cameraPoint(cam, 0.13, 0.88, aspect);
      const w = worldPoint(cam, s.x, s.y, aspect);
      expect(w.x).toBeCloseTo(0.13);
      expect(w.y).toBeCloseTo(0.88);
    }
  });

  test("camera keys ease, and zoom moves by ratio", () => {
    const cam = {
      kf: [
        { t: 0, x: 0.2, y: 0.5, scale: 1, rotation: 0, ease: "sine.inOut" as const },
        { t: 2, x: 0.8, y: 0.5, scale: 4, rotation: 0 },
      ],
    };
    const mid = cameraAt(cam, 1);
    expect(mid.x).toBeCloseTo(0.5);
    expect(mid.scale).toBeCloseTo(2); // the geometric middle of 1× and 4×
    expect(cameraAt(cam, 0.5).x).toBeLessThan(0.35); // eased in
    expect(cameraAt(cam, 9).x).toBeCloseTo(0.8); // held after the last key
  });

  test("the evaluator films a member through its group's camera", () => {
    const o = el({ x: 0.25, y: 0.3, camera: { kf: [{ t: 0, x: 0.25, y: 0.3, scale: 2, rotation: 0 }] } });
    expect(isOverlayAnimated(o)).toBe(true);
    const f = evalOverlayFrame(o, 1, 16 / 9);
    expect(f.x).toBeCloseTo(0.5);
    expect(f.scale).toBeCloseTo(2);
    expect(() => evalOverlayFrame(o, 1)).toThrow();
  });

  test("a shifted camera reads the same moment on a member's new clock", () => {
    const cam = { kf: [{ t: 1, x: 0.2, y: 0.5, scale: 1, rotation: 0 }, { t: 3, x: 0.8, y: 0.5, scale: 1, rotation: 0 }] };
    // The member's start moved 0.5s later; its keys come 0.5s sooner.
    expect(cameraAt(shiftCamera(cam, -0.5), 1.5).x).toBeCloseTo(cameraAt(cam, 2).x);
  });
});

describe("blur on the pose track", () => {
  test("a key carries blur, and one without takes the element's", () => {
    const o = el({ blur: 4, kf: [key(0, { blur: 0 }), key(2)] });
    expect(poseAt(o, 0).blur ?? 0).toBeCloseTo(0);
    expect(poseAt(o, 1).blur).toBeCloseTo(2);
    expect(poseAt(o, 3).blur).toBeCloseTo(4);
    expect(evalOverlayFrame(o, 1).blur).toBeCloseTo(2);
  });

  test("a still blurred element renders as one picture", () => {
    expect(isOverlayAnimated(el({ blur: 3 }))).toBe(false);
    expect(isOverlayAnimated(el({ blur: 3, kf: [key(0), key(2, { blur: 0 })] }))).toBe(true);
  });
});

describe("motion blur", () => {
  const moving = (over: Record<string, unknown> = {}) =>
    el({ motionBlur: 0.5, kf: [key(0, { x: 0.2 }), key(2, { x: 0.8 })], ...over });

  test("the streak is the screen travel over the exposure", () => {
    const aspect = 16 / 9;
    const f = evalOverlayFrame(moving(), 1, aspect);
    // 0.6 of a 1920-design-px frame over 2s, for half a 30fps frame.
    const speed = (0.6 * 1080 * aspect) / 2;
    expect(f.streak!.x).toBeCloseTo(speed * 0.5 * MOTION_BLUR_FRAME, 3);
    expect(f.streak!.y).toBeCloseTo(0);
  });

  test("a still element stays sharp", () => {
    expect(evalOverlayFrame(moving(), 3, 1).streak).toBeUndefined();
    expect(evalOverlayFrame(el({ motionBlur: 0.5 }), 1, 1).streak).toBeUndefined();
  });

  test("the streak grows with speed and with the shutter", () => {
    const slow = evalOverlayFrame(moving({ kf: [key(0, { x: 0.4 }), key(2, { x: 0.6 })] }), 1, 1).streak!.x;
    const fast = evalOverlayFrame(moving(), 1, 1).streak!.x;
    expect(fast / slow).toBeCloseTo(3);
    const wide = evalOverlayFrame(moving({ motionBlur: 1 }), 1, 1).streak!.x;
    expect(wide / fast).toBeCloseTo(2);
  });

  test("the first frame streaks like the rest", () => {
    const a = evalOverlayFrame(moving(), 0, 1).streak!.x;
    const b = evalOverlayFrame(moving(), 1, 1).streak!.x;
    expect(a).toBeCloseTo(b);
  });

  test("the camera's motion blur streaks only the camera's move", () => {
    const camera = {
      motionBlur: 0.5,
      kf: [
        { t: 0, x: 0.3, y: 0.5, scale: 1, rotation: 0 },
        { t: 2, x: 0.7, y: 0.5, scale: 1, rotation: 0 },
      ],
    };
    // The element's own travel (down) is left sharp; the camera pans right,
    // so the world slides left on screen.
    const o = el({ camera, kf: [key(0, { y: 0.2 }), key(2, { y: 0.8 })] });
    const f = evalOverlayFrame(o, 1, 1);
    expect(f.streak!.x).toBeLessThan(0);
    expect(f.streak!.y).toBeCloseTo(0);
    // Its own switch streaks everything it does on screen.
    const own = evalOverlayFrame({ ...o, motionBlur: 0.5 }, 1, 1);
    expect(own.streak!.y).toBeGreaterThan(0);
    expect(own.streak!.x).toBeLessThan(0);
  });

  test("streak length is capped and short streaks vanish", () => {
    expect(capStreak(STREAK_MIN / 2, 0)).toBeNull();
    const long = capStreak(1000, 1000)!;
    expect(Math.hypot(long.x, long.y)).toBeCloseTo(STREAK_MAX);
    expect(long.x).toBeCloseTo(long.y);
    expect(capStreak(10, 0)).toEqual({ x: 10, y: 0 });
  });

  test("taps follow the streak length within their bounds", () => {
    expect(streakTaps(0)).toBe(0);
    expect(streakTaps(STREAK_MIN)).toBe(2);
    expect(streakTaps(20)).toBeGreaterThan(streakTaps(8));
    expect(streakTaps(STREAK_MAX)).toBe(STREAK_TAPS_MAX);
  });

  test("the look scales to output px and is null for a sharp still frame", () => {
    expect(elementLook({}, 2)).toBeNull();
    const look = elementLook({ blur: 3, streak: { x: 10, y: 0 } }, 2)!;
    expect(look.blur).toBeCloseTo(6);
    expect(look.streakX).toBeCloseTo(20);
    expect(look.taps).toBe(streakTaps(10));
  });
});
