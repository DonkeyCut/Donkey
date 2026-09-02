import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Timed } from "./frameSource";
import type { MediaAsset } from "./types";

// ── the files a source reads, stood in for ──────────────────────────────────
// Only the reads are replaced; the module mock spreads the real module, so
// every other export is carried through as it is (and other test files in the
// run see the real behavior for everything but these).

interface FakeInput {
  url: string;
  disposed: boolean;
  dispose(): void;
}
const inputs: FakeInput[] = [];
/** Addresses whose open is held until the test releases or refuses it. */
const gates = new Map<string, { promise: Promise<void>; release(): void; refuse(): void }>();
const gate = (url: string) => {
  let release!: () => void;
  let refuse!: () => void;
  const promise = new Promise<void>((res, rej) => {
    release = res;
    refuse = () => rej(new Error("no track"));
  });
  const g = { promise, release, refuse };
  gates.set(url, g);
  return g;
};

const openMedia = ((src: string | Blob) => {
  const input: FakeInput = {
    url: String(src),
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  };
  inputs.push(input);
  return input;
}) as never;

interface FakeTrack {
  url: string;
  codec: string;
  getDurationFromMetadata(): Promise<number>;
}
const videoTrackOf = (async (input: FakeInput) => {
  const g = gates.get(input.url);
  if (g) await g.promise;
  const track: FakeTrack = { url: input.url, codec: "avc1", getDurationFromMetadata: async () => 10 };
  return track;
}) as never;

/** Every walk a fake sink was asked for, with the address it reads and the
 * height it decodes at. */
const sinkWalks: { url: string; from: number; height: number }[] = [];
/** Hold every walk on sinks of this height until released, to stand in for a
 * decoder that cannot keep up with the pointer. */
let stall: { height: number; promise: Promise<void> } | null = null;
const frame = (track: FakeTrack, timestamp: number) => ({
  canvas: { width: 640, height: 360 },
  timestamp,
  duration: 1 / 30,
});
const frameSink = ((track: FakeTrack, size?: { height?: number }) => ({
  async *canvases(from: number) {
    sinkWalks.push({ url: track.url, from, height: size?.height ?? 0 });
    if (stall && size?.height === stall.height) await stall.promise;
    for (let i = 0; ; i++) {
      const timestamp = from + i / 30;
      if (timestamp > 10) return;
      yield frame(track, timestamp);
    }
  },
  async getCanvas(t: number) {
    return frame(track, t);
  },
  async *canvasesAtTimestamps(asks: number[]) {
    for (const t of asks) yield frame(track, t);
  },
})) as never;
const keyframeTimeAt = (async (_track: unknown, t: number) => Math.max(0, Math.floor(t))) as never;

const media = await import("./mediaRead");
// The shared open, over the fake files: one input per URL, closed by the
// last holder to let go, the way the real one is.
const shared = new Map<string, { input: FakeInput; refs: number }>();
const openMediaShared = (src: string) => {
  let entry = shared.get(src);
  if (!entry) {
    entry = { input: (openMedia as unknown as (s: string) => FakeInput)(src), refs: 0 };
    shared.set(src, entry);
  }
  const held = entry;
  held.refs++;
  let released = false;
  return {
    input: held.input,
    release() {
      if (released) return;
      released = true;
      if (--held.refs > 0) return;
      if (shared.get(src) === held) shared.delete(src);
      held.input.dispose();
    },
  };
};
mock.module("./mediaRead", () => ({
  ...media,
  openMedia,
  openMediaShared,
  videoTrackOf,
  frameSink,
  keyframeTimeAt,
}));

const { BACK_WINDOW, ClipFrameSource, FrameRing, FrameSourcePool, mappingKey, walkClaim } =
  await import("./frameSource");

/** Let the opens, walks and drains the last call set going run out. */
const settle = async (rounds = 400) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

/** A decoded frame at 30fps, as the sink would hand it over. */
const f = (timestamp: number, duration = 1 / 30): Timed => ({ timestamp, duration });

const asset = (id: string, width = 1280, height = 720): MediaAsset => ({
  id,
  name: `${id}.mp4`,
  fileName: `${id}.mp4`,
  type: "video",
  url: `https://example.test/${id}.mp4`,
  duration: 10,
  width,
  height,
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

  test("nearer merges two rings' answers under at()'s own policy", () => {
    // The backward walk's windows and the main ring each answer separately; the
    // frame served is the one a single ring holding both would have picked.
    const a = f(1);
    const b = f(2);
    const late = f(5);
    // A frame at or before the ask beats one after it.
    expect(FrameRing.nearer(3, a, late)).toBe(a);
    expect(FrameRing.nearer(3, late, a)).toBe(a);
    // Of two before, the later; of two after, the earlier.
    expect(FrameRing.nearer(3, a, b)).toBe(b);
    expect(FrameRing.nearer(0.5, a, b)).toBe(a);
    // A lone answer stands.
    expect(FrameRing.nearer(3, null, b)).toBe(b);
    expect(FrameRing.nearer(3, a, null)).toBe(a);
    expect(FrameRing.nearer(3, null, null)).toBe(null);
  });

  test("a window keeps the answer on the asking clip's side of a split", () => {
    // Two clips split from one file share a ring. The clip past the split asks
    // inside its own span; a garden frame from before the split is nearer but
    // shows the other scene.
    const ring = new FrameRing<Timed>(16);
    ring.push(f(45.4));
    ring.push(f(45.5));
    ring.push(f(46.0));
    // Ask at 45.68 in a clip whose span starts at the 45.57 split: the frames
    // before the split are out, and the earliest in-window frame answers.
    expect(ring.at(45.68, 45.57, 60)?.timestamp).toBeCloseTo(46.0);
    // The clip before the split never shows the far side.
    expect(ring.at(45.55, 40, 45.57)?.timestamp).toBeCloseTo(45.5);
    expect(ring.at(46.2, 40, 45.57)?.timestamp).toBeCloseTo(45.5);
  });

  test("a frame spanning the window's edge still answers inside it", () => {
    // A split lands mid-frame: the frame covering the second clip's `in`
    // starts just before it, and it is that clip's real first picture.
    const ring = new FrameRing<Timed>(16);
    ring.push(f(45.55));
    expect(ring.at(45.58, 45.57, 60)?.timestamp).toBeCloseTo(45.55);
  });

  test("nothing on the asking side answers null", () => {
    const ring = new FrameRing<Timed>(16);
    ring.push(f(45.4));
    expect(ring.at(46.1, 45.57, 60)).toBe(null);
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

describe("walkClaim", () => {
  /** A walk that has landed frames from `from` to `tail`, asked for `t`. */
  const landed = (t: number, from: number, tail: number, covered = false, heldBefore = true) =>
    walkClaim({
      t, walkFor: from, from, tail, landed: true, covered, heldBefore, comingS: 5, playing: true,
    });

  test("playback inside the walk keeps it", () => {
    // The ordinary tick: the playhead is a beat behind the walk's tail and the
    // frame is in the ring. Anything but `hold` here is a decode per frame.
    expect(landed(3, 2, 3.3, true)).toBe("hold");
  });

  test("a walk running behind keeps its claim until it is history", () => {
    // Frames still land; the picture advances a beat late. Restarting would
    // pay a fresh keyframe seek to be in the same place.
    expect(landed(4, 2, 3)).toBe("hold");
    expect(landed(5, 2, 3.5)).toBe("hold");
    // Past the allowance the frames it is about to land are already gone by.
    expect(landed(6, 2, 3.5)).toBe("hop");
  });

  test("a walk ahead of the reader is kept, however far ahead it is", () => {
    // A walk holding its lookahead is always a little way past the reader, and
    // the ring stops covering that moment before the walk has done anything
    // wrong. Measured on a laptop's montage, tearing one down there took a
    // clean run to a seventh of its frames late — every lapse in coverage
    // bought a fresh keyframe seek.
    expect(landed(3, 2, 3.3)).toBe("hold");
    expect(landed(3, 2, 4.9)).toBe("hold");
    expect(landed(1, 0, 8)).toBe("hold");
  });

  test("a reader re-entering behind everything the walk left restarts it", () => {
    // A montage replayed from the top: the walk from the last pass sits at the
    // clip's end, the ring holds only its final frames, and the reader asks
    // for the clip's head — the moment the walk was first sent for. Held, the
    // clip shows its last frame for the whole pass while the sound plays on.
    expect(landed(0, 0, 8, false, false)).toBe("restart");
    // The same walk holding no more than its lookahead is left to land it.
    expect(landed(7.8, 0, 8, false, false)).toBe("hold");
  });

  test("a walk aimed ahead is kept while the reader catches up to it", () => {
    // A hop anchors ahead of the reader by what reaching a frame costs. The
    // reader is behind the anchor by construction, and that is not the walk
    // going past it — it is the walk about to be right.
    const lead = {
      t: 4, walkFor: 4, from: 4.5, tail: 4.6, landed: true, covered: false, heldBefore: true, playing: true,
    };
    expect(walkClaim({ ...lead, comingS: 5 })).toBe("hold");
    expect(walkClaim({ ...lead, t: 4.4, comingS: 5 })).toBe("hold");
    // A reader that jumps back behind where the walk was sent gets the moment
    // it asked for, not the lead.
    expect(walkClaim({ ...lead, t: 3, comingS: 5 })).toBe("restart");
  });

  test("a walk still coming is left to land", () => {
    // Nothing has landed: the keyframe seek, the bytes it needs, and every
    // frame from the keyframe forward are all in flight. Starting another asks
    // for the whole thing again, which on a reader short of bytes is the
    // difference between a walk that lands and one that never does.
    const coming = { walkFor: 2, from: 2, tail: 2, landed: false, covered: false, heldBefore: false, playing: true };
    expect(walkClaim({ ...coming, t: 2.5, comingS: 0.5 })).toBe("hold");
    expect(walkClaim({ ...coming, t: 9, comingS: 1.5 })).toBe("hold");
    // Past the lag it was meant to cure, at a reader that has run beyond it,
    // waiting only widens the gap it will land into.
    expect(walkClaim({ ...coming, t: 9, comingS: 3 })).toBe("hop");
    // Still coming, and the reader has not passed it: there is nothing better
    // to do than let it land.
    expect(walkClaim({ ...coming, t: 3, comingS: 3 })).toBe("hold");
    // A reader behind where it was sent is not waiting for it at all.
    expect(walkClaim({ ...coming, t: 1, comingS: 0.1 })).toBe("restart");
  });

  test("a frame in hand beats every other rule", () => {
    expect(walkClaim({
      t: 0, walkFor: 5, from: 5, tail: 9, landed: true, covered: true, heldBefore: false, comingS: 9, playing: true,
    })).toBe("hold");

    // A paused reader is served by the backward walk and by the single-frame
    // fetch, so a walk it cannot use is left where it is.
    expect(walkClaim({
      t: 1, walkFor: 5, from: 5, tail: 6, landed: true, covered: false, heldBefore: false, comingS: 9, playing: false,
    })).toBe("hold");
  });
});

describe("FrameSourcePool", () => {
  // The pool's budgets are the smaller of what it was tuned to want and this
  // machine's share, and these tests are about the tuning: they put the pool
  // on a machine with room, which is what a sixteen-gigabyte report is, and
  // hand the machine back after.
  beforeEach(() => {
    Object.defineProperty(navigator, "deviceMemory", { value: 16, configurable: true });
  });
  afterEach(() => {
    delete (navigator as { deviceMemory?: number }).deviceMemory;
  });

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

  test("a source follows its asset's URL, in place", () => {
    // A signed URL re-mints, or an import lands in project storage. The
    // mapping still names the same pictures at a new address, so the source
    // moves there itself — everything it has decoded keeps answering while
    // the new address opens behind it.
    const pool = new FrameSourcePool(4);
    pool.beginFrame();
    const before = pool.get("k", asset("a"), 480);
    expect(pool.get("k", asset("a"), 480)).toBe(before);
    const moved = { ...asset("a"), url: "https://example.test/a.mp4?e=2&s=next" };
    const after = pool.get("k", moved, 480);
    expect(after).toBe(before);
    expect(after.url).toBe(moved.url);
    expect(pool.size).toBe(1);
  });

  test("suspends the least recently asked-for, never this frame's", () => {
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
    // Past the budget the idle ones stand down, and standing down keeps the
    // source — its parsed file and its sink's canvases — so the next visit
    // finds the same instance instead of paying for a fresh open.
    expect(pool.size).toBe(3);
    expect(pool.get("live", asset("c"), 480)).toBe(live);
    expect(pool.get("mid", asset("b"), 480)).toBe(mid);
    expect(pool.get("old", asset("a"), 480)).toBe(old);
  });

  test("idle decoders stand down by the pixels they cover", () => {
    const uhd = (id: string) => asset(id, 3840, 2160);
    const hd = (id: string) => asset(id, 1920, 1080);
    const ids = ["a", "b", "c", "d", "e", "f"];
    const pool = new FrameSourcePool(12);
    const big = ids.map((id) => {
      pool.beginFrame();
      return pool.get(id, uhd(id), 480);
    });
    const small = ids.map((id) => {
      pool.beginFrame();
      return pool.get(`${id}-hd`, hd(id), 480);
    });
    for (let i = 0; i < 200; i++) pool.beginFrame();
    pool.evict();
    // Twelve decoders are inside the count. The six 1080p files are read
    // most recently and fit the pixel budget together; behind them the 4K
    // files fill what is left, and the oldest stand down.
    expect(small.map((s) => s.suspended)).toEqual(ids.map(() => false));
    expect(big.map((s) => s.suspended)).toEqual([true, true, true, true, false, false]);
  });

  test("says what it is holding, live sources included", () => {
    const pool = new FrameSourcePool(4);
    expect(pool.decoderBytes).toBe(0);
    expect(pool.canvasBytes).toBe(0);
    pool.beginFrame();
    pool.get("a", asset("a", 3840, 2160), 2160);
    // A live 4K decoder holds sixteen planar frames: about two hundred
    // megabytes, none of which the warm shelf's own number would ever show.
    expect(Math.round(pool.decoderBytes / 2 ** 20)).toBe(190);
    expect(pool.warmPixels).toBe(0);
    expect(pool.canvasBytes).toBeGreaterThan(0);
    // One 4K source is well inside the budget, so nothing stands down.
    for (let i = 0; i < 200; i++) pool.beginFrame();
    pool.evict();
    expect(pool.decoderBytes).toBeGreaterThan(0);

    // Standing down gives the decoder back and keeps the canvases, which is
    // the whole point of the warm shelf.
    const tight = new FrameSourcePool(0);
    tight.beginFrame();
    tight.get("a", asset("a", 1920, 1080), 1080);
    const canvases = tight.canvasBytes;
    for (let i = 0; i < 200; i++) tight.beginFrame();
    tight.evict();
    expect(tight.decoderBytes).toBe(0);
    expect(tight.canvasBytes).toBe(canvases);
  });

  test("standing down costs a decoder, not a source", () => {
    const pool = new FrameSourcePool(1);
    pool.beginFrame();
    const a = pool.get("a", asset("a"), 360);
    pool.beginFrame();
    pool.get("b", asset("b"), 360);
    for (let i = 0; i < 200; i++) pool.beginFrame();
    // Both are idle and the budget is one, so the older gives up its decoder.
    pool.evict();
    expect(pool.size).toBe(2);
    expect(pool.active).toBe(1);
    // Suspension is a state: evicting again changes nothing, and reading the
    // source is what wakes it.
    pool.evict();
    expect(pool.active).toBe(1);
    a.want(0, false);
    expect(pool.active).toBe(2);
  });

  test("closes what the canvas budget cannot keep", () => {
    // Big frames: a handful of sinks is the whole budget, so a montage of them
    // is bounded by memory rather than by a count.
    const pool = new FrameSourcePool(2);
    for (let i = 0; i < 24; i++) {
      pool.beginFrame();
      pool.get(`s${i}`, asset(`x${i}`, 3840, 2160), 2160);
    }
    for (let i = 0; i < 200; i++) pool.beginFrame();
    pool.evict();
    expect(pool.size).toBeLessThan(6);
    // Small frames of the same count fit, and all of them stay.
    const small = new FrameSourcePool(2);
    for (let i = 0; i < 24; i++) {
      small.beginFrame();
      small.get(`s${i}`, asset(`x${i}`, 640, 360), 360);
    }
    for (let i = 0; i < 200; i++) small.beginFrame();
    small.evict();
    expect(small.size).toBe(24);
    expect(small.active).toBe(2);
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

describe("ClipFrameSource retarget", () => {
  const reset = () => {
    inputs.length = 0;
    sinkWalks.length = 0;
    gates.clear();
  };

  test("the picture rides its ring across a change of address", async () => {
    // The failure this is here for: a library clip lands in project storage
    // mid-play and its asset moves to the stored URL, and closing the source
    // there put a cold open — a container read over the link, an empty ring —
    // in front of the very next frame. The frames already decoded carry the
    // picture while the new address opens behind them.
    reset();
    const before = asset("ride");
    const src = new ClipFrameSource(before, 360);
    src.want(0.1, true);
    await settle();
    expect(src.frameAt(0.1)).not.toBeNull();
    const movedUrl = "https://example.test/ride-landed.mp4";
    const g = gate(movedUrl);
    src.retarget({ ...before, url: movedUrl });
    expect(src.url).toBe(movedUrl);
    await settle();
    // The new address has not opened yet: everything decoded keeps answering,
    // and the old stack keeps walking frames in.
    expect(src.frameAt(0.1)).not.toBeNull();
    src.want(0.3, true);
    await settle();
    expect(src.frameAt(0.3)).not.toBeNull();
    expect(inputs[0].disposed).toBe(false);
    g.release();
    await settle();
    // The stack swapped: the old file let go, the frames kept.
    expect(inputs[0].disposed).toBe(true);
    expect(src.frameAt(0.3)).not.toBeNull();
    src.want(0.6, true);
    await settle();
    // The walk carrying on reads the new address.
    expect(sinkWalks[sinkWalks.length - 1].url).toBe(movedUrl);
    expect(src.frameAt(0.6)).not.toBeNull();
    src.close();
  });

  test("a new address that will not open leaves the picture standing", async () => {
    reset();
    const before = asset("stay");
    const src = new ClipFrameSource(before, 360);
    src.want(0.1, true);
    await settle();
    expect(src.frameAt(0.1)).not.toBeNull();
    const movedUrl = "https://example.test/stay-gone.mp4";
    const g = gate(movedUrl);
    src.retarget({ ...before, url: movedUrl });
    await settle();
    g.refuse();
    await settle();
    // The failed open is spent on the probe alone: the frames stay, the old
    // file stays open, and the usual retries go after the new address.
    expect(src.frameAt(0.1)).not.toBeNull();
    expect(inputs[0].disposed).toBe(false);
    expect(inputs[inputs.length - 1].disposed).toBe(true);
    src.close();
  });
});

describe("ClipFrameSource replay", () => {
  test("a playing reader back at a clip's head gets a fresh walk", async () => {
    // The cut played once: the walk read the clip from 2s to its end at 5s and
    // stopped there, holding its lookahead. The play button then seeks to zero
    // and starts the clock in the same turn, so the clip is asked for 2s again
    // while playing — behind everything the ring holds. A held walk here is
    // the report of a picture that stops while the sound plays on.
    inputs.length = 0;
    sinkWalks.length = 0;
    gates.clear();
    const src = new ClipFrameSource(asset("replay"), 360);
    src.want(2, true);
    await settle();
    for (let t = 2; t <= 5; t += 0.1) {
      src.want(+t.toFixed(3), true);
      await settle(50);
    }
    expect(src.frameAt(5)?.timestamp).toBeGreaterThanOrEqual(5 - 1e-3);
    expect(src.hasExact(2)).toBe(false);
    const walksBefore = sinkWalks.length;
    src.want(2, true);
    await settle();
    expect(sinkWalks.length).toBe(walksBefore + 1);
    expect(sinkWalks[sinkWalks.length - 1].from).toBeCloseTo(2, 3);
    expect(src.hasExact(2)).toBe(true);
    expect(src.frameAt(2)?.timestamp).toBeCloseTo(2, 3);
    src.close();
  });

  test("an ordinary tick never restarts the walk", async () => {
    // The same play, watched tick by tick: the reader is always a beat behind
    // the walk's tail with the frame on screen in hand, and one walk carries
    // the whole clip.
    inputs.length = 0;
    sinkWalks.length = 0;
    gates.clear();
    const src = new ClipFrameSource(asset("steady"), 360);
    src.want(2, true);
    await settle();
    const walks = sinkWalks.length;
    for (let t = 2; t <= 5; t += 1 / 60) {
      src.want(+t.toFixed(4), true);
      await settle(50);
      expect(src.frameAt(t)).not.toBeNull();
    }
    expect(sinkWalks.length).toBe(walks);
    src.close();
  });
});

describe("ClipFrameSource backward walk", () => {
  const reset = () => {
    inputs.length = 0;
    sinkWalks.length = 0;
    gates.clear();
    stall = null;
  };
  const dt = 1 / 30;

  test("a creep backward is answered from windows landed below the pointer", async () => {
    // The report: dragging the playhead backward stutters. Frames decode
    // forward from a keyframe, so each backward step used to cost a keyframe
    // walk of its own, thrown away by the next step. Here the pointer backs
    // through two seconds a frame at a time and finds each frame already in
    // hand: one keyframe decode per window of frames, the next window landed
    // while the pointer crosses the current one.
    reset();
    const src = new ClipFrameSource(asset("back"), 360);
    src.want(6, false);
    await settle();
    expect(src.hasExact(6)).toBe(true);
    const walksBefore = sinkWalks.length;
    let waited = 0;
    for (let t = 6 - dt; t >= 4; t -= dt) {
      const at = +t.toFixed(4);
      src.want(at, false);
      if (!src.hasExact(at)) waited++;
      await settle(60);
      expect(src.hasExact(at)).toBe(true);
      expect(Math.abs(src.frameAt(at)!.timestamp - at)).toBeLessThan(dt);
    }
    // Only the first step waits on a fill; every later one lands inside a
    // window already there.
    expect(waited).toBeLessThanOrEqual(1);
    // Sixty frames back is six windows, plus the ones clamped at a keyframe.
    const walks = sinkWalks.length - walksBefore;
    expect(walks).toBeLessThanOrEqual(60 / BACK_WINDOW + 4);
    src.close();
  });

  test("a drag that outruns the windows still has a picture near the pointer", async () => {
    // The fine windows are held back, as a decoder that cannot keep up would
    // hold them; the coarse spread over the keyframe span lands regardless
    // and stands in near the pointer until the window arrives.
    reset();
    const src = new ClipFrameSource(asset("fast"), 720);
    src.want(7.5, false);
    await settle();
    let release!: () => void;
    stall = { height: 720, promise: new Promise<void>((r) => (release = r)) };
    src.want(7.4, false);
    await settle(60);
    src.want(7.05, false);
    await settle(60);
    expect(src.hasExact(7.05)).toBe(false);
    const near = src.frameAt(7.05);
    expect(near).not.toBeNull();
    expect(Math.abs(near!.timestamp - 7.05)).toBeLessThan(0.1);
    release();
    stall = null;
    await settle();
    // The walk catches up: the window ending at the pointer lands.
    expect(src.hasExact(7.05)).toBe(true);
    expect(Math.abs(src.frameAt(7.05)!.timestamp - 7.05)).toBeLessThan(dt);
    src.close();
  });

  test("turning forward again rides the forward walk", async () => {
    reset();
    const src = new ClipFrameSource(asset("turn"), 360);
    src.want(5, false);
    await settle();
    for (let t = 5 - dt; t >= 4.5; t -= dt) {
      src.want(+t.toFixed(4), false);
      await settle(60);
    }
    const walksBefore = sinkWalks.length;
    for (let t = 4.5 + dt; t <= 5.5; t += dt) {
      const at = +t.toFixed(4);
      src.want(at, false);
      await settle(60);
      expect(src.hasExact(at)).toBe(true);
    }
    // Back through the windows costs nothing; past them, one walk creeps on.
    expect(sinkWalks.length - walksBefore).toBeLessThanOrEqual(2);
    src.close();
  });

  test("playing lets the backward frames go", async () => {
    reset();
    const src = new ClipFrameSource(asset("play"), 360);
    src.want(5, false);
    await settle();
    src.want(5 - dt, false);
    await settle();
    expect(src.debugState().back).not.toBeNull();
    src.want(5 - dt, true);
    await settle();
    expect(src.debugState().back).toBeNull();
    src.close();
  });

  test("only the sources this frame reads hold backward frames", async () => {
    // Backward frames are two sinks' worth of canvases. A montage backed
    // through would keep a set per clip crossed; the pool keeps them on what
    // this frame reads — the pointer's clip and the neighbour warmed under it
    // — and a clip the pointer has left lets its go the moment another walk
    // starts.
    reset();
    const pool = new FrameSourcePool(4);
    pool.beginFrame();
    const a = pool.get("a", asset("a"), 360);
    a.want(5, false);
    await settle();
    a.want(5 - dt, false);
    await settle();
    expect(a.debugState().back).not.toBeNull();
    pool.beginFrame();
    const b = pool.get("b", asset("b"), 360);
    b.want(5, false);
    await settle();
    b.want(5 - dt, false);
    await settle();
    expect(b.debugState().back).not.toBeNull();
    expect(a.debugState().back).toBeNull();
    // Both read in one frame — the pointer's clip and the one warmed below
    // it — keep theirs together.
    pool.beginFrame();
    pool.get("a", asset("a"), 360);
    pool.get("b", asset("b"), 360);
    a.want(5, false);
    await settle();
    a.want(5 - dt, false);
    await settle();
    expect(a.debugState().back).not.toBeNull();
    expect(b.debugState().back).not.toBeNull();
    pool.closeAll();
  });
});
