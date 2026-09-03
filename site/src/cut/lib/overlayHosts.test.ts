import { describe, expect, test } from "bun:test";
import type { Overlay } from "@donkeycut/effects-kit";
import type { VideoClip } from "./types";
import { adoptOverlayHosts, hostClipFor, settleOverlayHosts } from "./overlayHosts";

const clip = (p: Partial<VideoClip> & { id: string }): VideoClip =>
  ({ track: 0, assetId: "a", start: 0, in: 0, out: 10, muted: false, ...p }) as VideoClip;
const title = (p: Partial<Overlay> & { id: string }): Overlay =>
  ({ kind: "text", text: "hi", x: 0.5, y: 0.5, start: 2, end: 4, ...p }) as Overlay;

const c = clip({ id: "c1", start: 10, in: 0, out: 10 });
const t = title({ id: "t1", start: 12, end: 14, hostClipId: "c1" });

describe("element hosts", () => {
  test("a placed element homes to the clip under its middle, highest track first", () => {
    const low = clip({ id: "lo", start: 0, out: 20, track: 0 });
    const high = clip({ id: "hi", start: 5, out: 10, track: 1 });
    expect(hostClipFor([low, high], { start: 6, end: 8 })?.id).toBe("hi");
    expect(hostClipFor([low, high], { start: 1, end: 3 })?.id).toBe("lo");
    expect(hostClipFor([low, high], { start: 30, end: 32 })).toBeUndefined();
  });

  test("a moved host carries its element by the same distance", () => {
    const moved = { ...c, start: 40 };
    const r = settleOverlayHosts([c], [moved], [t], [t])!;
    expect(r.overlays[0].start).toBe(42);
    expect(r.overlays[0].end).toBe(44);
    expect(r.carried.has("t1")).toBe(true);
  });

  test("a retimed host stretches the element with the picture, keys included", () => {
    const keyed = { ...t, kf: [{ t: 1, x: 0.2, y: 0.2 }] } as Overlay;
    const slow = { ...c, speed: 0.5 };
    const r = settleOverlayHosts([c], [slow], [keyed], [keyed])!;
    expect(r.overlays[0].start).toBeCloseTo(14, 6);
    expect(r.overlays[0].end).toBeCloseTo(18, 6);
    expect(r.overlays[0].kf![0].t).toBeCloseTo(2, 6);
  });

  test("a head trim leaves the element on the frames it covered", () => {
    const trimmed = { ...c, start: 11, in: 1 };
    expect(settleOverlayHosts([c], [trimmed], [t], [t])).toBeNull();
  });

  test("a split hands the element to the half that plays its frames", () => {
    const left = { ...c, out: 1.5 };
    const right = clip({ id: "c2", start: 11.5, in: 1.5, out: 10 });
    const r = settleOverlayHosts([c], [left, right], [t], [t])!;
    expect(r.overlays[0].start).toBe(12);
    expect(r.overlays[0].hostClipId).toBe("c2");
  });

  test("a ripple that already moved the element with its footage changes nothing", () => {
    const moved = { ...c, start: 15 };
    const rippled = { ...t, start: 17, end: 19 };
    expect(settleOverlayHosts([c], [moved], [t], [rippled])).toBeNull();
  });

  test("an element dragged by hand homes where it lands", () => {
    const other = clip({ id: "c2", start: 30, out: 10 });
    const dragged = { ...t, start: 33, end: 35 };
    const r = settleOverlayHosts([c, other], [c, other], [t], [dragged])!;
    expect(r.overlays[0].hostClipId).toBe("c2");
  });

  test("a deleted host leaves the element in place, homed to what is there now", () => {
    const next = clip({ id: "c2", start: 10, out: 10 });
    const r = settleOverlayHosts([c], [next], [t], [t])!;
    expect(r.overlays[0].start).toBe(12);
    expect(r.overlays[0].hostClipId).toBe("c2");
    const gone = settleOverlayHosts([c], [], [t], [t])!;
    expect(gone.overlays[0].hostClipId).toBeUndefined();
  });

  test("a freed element stays free through every write", () => {
    const free = { ...t, hostClipId: null } as Overlay;
    expect(settleOverlayHosts([c], [{ ...c, start: 40 }], [free], [free])).toBeNull();
    const dragged = { ...free, start: 20, end: 22 };
    expect(settleOverlayHosts([c], [c], [free], [dragged])).toBeNull();
  });

  test("an older document's elements adopt the clips under them on load", () => {
    const bare = title({ id: "t2", start: 12, end: 14 });
    expect(adoptOverlayHosts([c], [bare])[0].hostClipId).toBe("c1");
    const off = title({ id: "t3", start: 50, end: 52 });
    expect(adoptOverlayHosts([c], [off])[0].hostClipId).toBeUndefined();
  });
});
