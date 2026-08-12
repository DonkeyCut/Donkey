import { describe, expect, test } from "bun:test";
import { FrameRing, FrameSourcePool, mappingKey, type Timed } from "./frameSource";
import type { MediaAsset } from "./types";

/** A decoded frame at 30fps, as the sink would hand it over. */
const f = (timestamp: number, duration = 1 / 30): Timed => ({ timestamp, duration });

const asset = (id: string): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  fileName: `${id}.mp4`,
  type: "video",
  url: `https://example.test/${id}.mp4`,
  duration: 10,
});

describe("FrameRing", () => {
  test("hands back the frame covering the asked-for time", () => {
    const ring = new FrameRing<Timed>(8);
    for (let i = 0; i < 5; i++) ring.push(f(i / 30));
    // Between two frames, the one that started is the one on screen.
    expect(ring.at(2.5 / 30)?.timestamp).toBeCloseTo(2 / 30);
    expect(ring.at(2 / 30)?.timestamp).toBeCloseTo(2 / 30);
  });

  test("answers past the end with the newest frame it holds", () => {
    // A decoder running behind the playhead should show the last real frame
    // rather than nothing — this is the "never withhold" rule.
    const ring = new FrameRing<Timed>(8);
    ring.push(f(0));
    ring.push(f(1 / 30));
    expect(ring.at(5)?.timestamp).toBeCloseTo(1 / 30);
  });

  test("answers before the first frame with the earliest it holds", () => {
    // At a clip's head the frame the cut opens on is the right thing to show.
    const ring = new FrameRing<Timed>(8);
    ring.push(f(2));
    ring.push(f(2 + 1 / 30));
    expect(ring.at(1)?.timestamp).toBeCloseTo(2);
  });

  test("empty ring has no answer", () => {
    expect(new FrameRing<Timed>(4).at(0)).toBe(null);
  });

  test("covers() separates a real frame from a held one", () => {
    const ring = new FrameRing<Timed>(8);
    ring.push(f(1));
    expect(ring.covers(1)).toBe(true);
    expect(ring.covers(1 + 0.5 / 30)).toBe(true);
    // Past this frame's own duration nothing is covered, even though `at`
    // still hands the frame over.
    expect(ring.covers(1 + 2 / 30)).toBe(false);
    expect(ring.at(1 + 2 / 30)?.timestamp).toBeCloseTo(1);
    expect(ring.covers(0.5)).toBe(false);
  });

  test("drops the oldest past capacity, so the canvas pool never wraps under it", () => {
    const ring = new FrameRing<Timed>(3);
    for (let i = 0; i < 6; i++) ring.push(f(i));
    expect(ring.size).toBe(3);
    expect(ring.oldest).toBeCloseTo(3);
    expect(ring.newest).toBeCloseTo(5);
    // The evicted frames are gone, not merely unreachable.
    expect(ring.at(0)?.timestamp).toBeCloseTo(3);
  });

  test("keep() drops what a reader moved away from", () => {
    const ring = new FrameRing<Timed>(16);
    for (let i = 0; i < 10; i++) ring.push(f(i));
    ring.keep(4, 6);
    expect(ring.size).toBe(3);
    expect(ring.oldest).toBeCloseTo(4);
    expect(ring.newest).toBeCloseTo(6);
  });
});

describe("mappingKey", () => {
  test("clips showing identical pictures share a decoder", () => {
    // A plain split: same file, same speed, and the same source time at
    // timeline zero. One decoder reads straight across the cut.
    const left = mappingKey("a", 1, 0, 0);
    const right = mappingKey("a", 1, 4, 4);
    expect(left).toBe(right);
  });

  test("different trims of one file keep their own decoders", () => {
    // Both live at timeline 4, showing different moments — a same-source
    // dissolve has to blend two distinct frames.
    expect(mappingKey("a", 1, 0, 4)).not.toBe(mappingKey("a", 1, 8, 4));
  });

  test("a speed change is a different mapping", () => {
    expect(mappingKey("a", 1, 0, 0)).not.toBe(mappingKey("a", 2, 0, 0));
  });

  test("different files never share", () => {
    expect(mappingKey("a", 1, 0, 0)).not.toBe(mappingKey("b", 1, 0, 0));
  });
});

describe("FrameSourcePool", () => {
  test("one source per mapping and size, reused across frames", () => {
    const pool = new FrameSourcePool(4);
    pool.beginFrame();
    const a = pool.get("k", asset("a"), 480);
    const b = pool.get("k", asset("a"), 480);
    expect(a).toBe(b);
    // A different preview size is a different decode.
    expect(pool.get("k", asset("a"), 240)).not.toBe(a);
    expect(pool.size).toBe(2);
  });

  test("a source follows its asset's URL", () => {
    // A signed URL re-mints, or a shot re-renders onto its asset id. The
    // mapping still names the same pictures, but they now live somewhere else,
    // so the old source is closed and a fresh one reads the new URL.
    const pool = new FrameSourcePool(4);
    pool.beginFrame();
    const before = pool.get("k", asset("a"), 480);
    expect(pool.get("k", asset("a"), 480)).toBe(before);
    const moved = { ...asset("a"), url: "https://example.test/a.mp4?e=2&s=next" };
    const after = pool.get("k", moved, 480);
    expect(after).not.toBe(before);
    expect(after.url).toBe(moved.url);
    expect(pool.size).toBe(1);
  });

  test("evicts the least recently asked-for, never this frame's", () => {
    const pool = new FrameSourcePool(2);
    pool.beginFrame();
    const old = pool.get("old", asset("a"), 480);
    pool.beginFrame();
    const mid = pool.get("mid", asset("b"), 480);
    // Let the grace expire on both, then draw a third from a frame of its own.
    for (let i = 0; i < 200; i++) pool.beginFrame();
    const live = pool.get("live", asset("c"), 480);
    expect(pool.size).toBe(3);
    pool.evict();
    // Down to the budget, and the one this frame is drawn from survives.
    expect(pool.size).toBe(2);
    expect(pool.get("live", asset("c"), 480)).toBe(live);
    expect(pool.get("mid", asset("b"), 480)).toBe(mid);
    expect(pool.get("old", asset("a"), 480)).not.toBe(old);
  });

  test("holds a source through the grace, so a busy cut never thrashes", () => {
    // A cut with more clips than the budget would otherwise close and reopen
    // decoders every frame, and reopening costs far more than the memory it
    // saves. Nothing is closed until it has gone unwanted for a while.
    const pool = new FrameSourcePool(1);
    pool.beginFrame();
    const a = pool.get("a", asset("a"), 480);
    pool.beginFrame();
    const b = pool.get("b", asset("b"), 480);
    pool.evict();
    expect(pool.size).toBe(2);
    expect(pool.get("a", asset("a"), 480)).toBe(a);
    expect(pool.get("b", asset("b"), 480)).toBe(b);
  });

  test("stays put while under budget", () => {
    const pool = new FrameSourcePool(4);
    pool.beginFrame();
    const a = pool.get("a", asset("a"), 480);
    pool.beginFrame();
    pool.evict();
    expect(pool.get("a", asset("a"), 480)).toBe(a);
  });
});
