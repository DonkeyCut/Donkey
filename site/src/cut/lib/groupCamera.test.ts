import { describe, expect, test } from "bun:test";
import { evalOverlayFrame } from "@donkeycut/effects-kit";
import { groupCameraOf, groupCameras, withGroupCamera } from "./groupCamera";
import type { Overlay } from "./types";

const card = (id: string, start: number, x: number): Overlay =>
  ({ id, kind: "text", text: id, start, end: start + 4, x, y: 0.5, groupId: "g1" }) as Overlay;

const keys = [
  { t: 0, x: 0.2, y: 0.5, scale: 1, rotation: 0 },
  { t: 2, x: 0.8, y: 0.5, scale: 2, rotation: 0 },
];

describe("group camera clocks", () => {
  test("each member stores the keys on its own clock and the group reads them back", () => {
    const board = withGroupCamera([card("a", 1, 0.2), card("b", 2, 0.8)], "g1", { keys, motionBlur: 0.5 });
    expect(board[0].camera!.kf.map((k) => k.t)).toEqual([0, 2]);
    expect(board[1].camera!.kf.map((k) => k.t)).toEqual([-1, 1]);
    const view = groupCameraOf(board, "g1")!;
    expect(view.start).toBe(1);
    expect(view.keys).toEqual(keys);
    expect(view.motionBlur).toBe(0.5);
    expect(groupCameras(board).map((v) => v.groupId)).toEqual(["g1"]);
  });

  test("every member sees the same camera at the same timeline moment", () => {
    const [a, b] = withGroupCamera([card("a", 1, 0.2), card("b", 2, 0.8)], "g1", { keys });
    // Timeline 2.5s: a is 1.5s in, b is 0.5s in. Both look through one camera,
    // so their screen gap is their world gap times the zoom.
    const fa = evalOverlayFrame(a, 1.5, 1);
    const fb = evalOverlayFrame(b, 0.5, 1);
    expect(fa.scale).toBeCloseTo(fb.scale);
    expect(fb.x - fa.x).toBeCloseTo(0.6 * fa.scale);
  });

  test("clearing removes the field from every member", () => {
    const board = withGroupCamera([card("a", 1, 0.2), card("b", 2, 0.8)], "g1", { keys });
    const cleared = withGroupCamera(board, "g1", { keys: [] });
    expect(cleared.every((o) => !("camera" in o))).toBe(true);
    expect(groupCameras(cleared)).toEqual([]);
  });
});
