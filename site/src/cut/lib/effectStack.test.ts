import { describe, expect, test } from "bun:test";
import { liveEffectsAt, placeWashes, washSlotsOf } from "./effectStack";
import type { Overlay } from "./types";

const film = (id: string, start: number, lane = 0) =>
  ({ id, kind: "effect", effect: "lightleak", leak: "film", amount: 1, start, end: start + 4 / 30, x: 0.5, y: 0.5, lane }) as Overlay;

// A film flash over every cut lays five screen washes. Mounting them as the
// flash starts and dropping them as it ends rebuilds the stage's compositing
// each time, and the preview holds a frame; the lane keeps them mounted
// instead, so a flash only moves their opacity.
describe("wash slots", () => {
  const overlays = [film("a", 1), film("b", 2), film("c", 3, 1)];

  test("a lane's slots cover every wash its effects lay, one set for repeats", () => {
    const slots = washSlotsOf(overlays, 0);
    expect(slots.length).toBe(5);
    expect(slots.every((s) => s.mode === "screen")).toBe(true);
    expect(new Set(slots.map((s) => s.key)).size).toBe(5);
    expect(washSlotsOf(overlays, 2)).toEqual([]);
  });

  test("a live flash lands in the lane's slots, and the slots stay put between flashes", () => {
    const slots = washSlotsOf(overlays, 0);
    const washesAt = (t: number) => liveEffectsAt(overlays, t).filter((e) => e.lane === 0).flatMap((e) => e.state.washes ?? []);
    const mid = placeWashes(slots, washesAt(1 + 2 / 30));
    expect(mid.extra).toEqual([]);
    expect(mid.alphas.every((a) => a > 0)).toBe(true);
    const between = placeWashes(slots, washesAt(1.5));
    expect(between).toEqual({ alphas: [0, 0, 0, 0, 0], extra: [] });
  });

  test("a wash with no slot of its own still shows", () => {
    const wash = { color: "#ffffff", alpha: 0.4, mode: "screen" as GlobalCompositeOperation };
    expect(placeWashes([], [wash])).toEqual({ alphas: [], extra: [wash] });
  });
});
