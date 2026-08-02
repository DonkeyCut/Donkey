import { beforeEach, describe, expect, test } from "bun:test";
import { clipLen, placeInRun, useEditor } from "./store";
import { emptySubtitles } from "./types";
import type { AudioClip, MediaAsset, SubtitleCue, TextOverlay, VideoClip } from "./types";

/**
 * The lane invariant: segments never overlap. Every placement and committed
 * update — user drops, AI-chat tools, inspector edits — must land items on a
 * free stretch of their lane (video per track, audio/title/cue per lane); the
 * one sanctioned exception is a declared cross-dissolve on track 0, which
 * physically overlaps its pair by the declared transition.
 */

let n = 0;
const asset = (duration = 4, type: MediaAsset["type"] = "video"): MediaAsset => ({
  id: `a${++n}`,
  fileName: `f${n}.mp4`,
  name: `A${n}`,
  type,
  duration,
  url: "",
});
const vclip = (o: Partial<VideoClip>): VideoClip => ({
  id: `c${++n}`,
  assetId: "x",
  track: 0,
  start: 0,
  in: 0,
  out: 2,
  muted: false,
  ...o,
});
const aclip = (o: Partial<AudioClip>): AudioClip => ({
  id: `au${++n}`,
  assetId: "x",
  start: 0,
  in: 0,
  out: 2,
  volume: 1,
  ...o,
});
const title = (o: Partial<TextOverlay>): TextOverlay => ({
  id: `t${++n}`,
  text: "T",
  start: 0,
  end: 2,
  x: 0.5,
  y: 0.5,
  size: 88,
  font: "sf",
  weight: 700,
  color: "#fff",
  shadow: true,
  plate: false,
  ...o,
});
const cue = (o: Partial<SubtitleCue>): SubtitleCue => ({
  id: `q${++n}`,
  start: 0,
  end: 1,
  text: "hi",
  ...o,
});

const s = () => useEditor.getState();
const clipById = (id: string) => s().clips.find((c) => c.id === id)!;
const audioById = (id: string) => s().audioClips.find((c) => c.id === id)!;

/** Assert no two footprints on one lane intrude into each other beyond the
 * per-pair allowance (a declared dissolve). */
function expectLaneSound(
  spans: { start: number; end: number }[],
  allow: (prev: number, next: number) => number = () => 0
) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i].start).toBeGreaterThanOrEqual(
      sorted[i - 1].end - allow(i - 1, i) - 1e-6
    );
  }
}
const videoLane = (track: number) =>
  s()
    .clips.filter((c) => c.track === track)
    .map((c) => ({ start: c.start, end: c.start + clipLen(c) }));

beforeEach(() => {
  useEditor.setState({
    clips: [],
    audioClips: [],
    overlays: [],
    assets: [],
    subtitles: emptySubtitles(),
    selection: null,
    multiSelection: [],
  });
});

describe("video placement", () => {
  test("adding onto an occupied upper track slides to the next free slot", () => {
    const a = asset(2);
    useEditor.setState({
      assets: [a],
      clips: [vclip({ track: 0, start: 0, out: 2 }), vclip({ track: 1, start: 1, out: 2 })],
    });
    s().addVideoFromAsset(a.id, { kind: "track", track: 1 }, 1.5);
    expectLaneSound(videoLane(1));
    const added = s().clips.find((c) => c.assetId === a.id)!;
    expect(added.start).toBeCloseTo(3);
  });

  test("adding onto a freshly inserted track keeps the requested start", () => {
    const a = asset(2);
    const spine = vclip({ track: 0, start: 0, out: 2 });
    const resident = vclip({ track: 1, start: 1, out: 2 });
    useEditor.setState({ assets: [a], clips: [spine, resident] });
    s().addVideoFromAsset(a.id, { kind: "insert", level: 1 }, 1.5);
    const added = s().clips.find((c) => c.assetId === a.id)!;
    expect(added.start).toBeCloseTo(1.5);
    expect(added.track).toBe(1);
    expect(clipById(resident.id).track).toBe(2); // renumbered above the insert
  });

  test("dragging a track-0 clip up onto an occupied track slides it clear", () => {
    const mover = vclip({ track: 0, start: 0, out: 2 });
    const anchor = vclip({ track: 0, start: 2, out: 2 });
    const resident = vclip({ track: 1, start: 1, out: 2 });
    useEditor.setState({ clips: [mover, anchor, resident] });
    s().dropVideoClip(mover.id, { kind: "track", track: 1 }, 1.2);
    expect(clipById(mover.id).track).toBe(1);
    expect(clipById(mover.id).start).toBeCloseTo(3);
    expectLaneSound(videoLane(1));
  });

  test("dropping a layer clip down onto occupied track 0 slides it clear", () => {
    const resident = vclip({ track: 0, start: 0, out: 2 });
    const mover = vclip({ track: 1, start: 0.5, out: 2 });
    useEditor.setState({ clips: [resident, mover] });
    s().dropVideoClip(mover.id, { kind: "track", track: 0 }, 1);
    expect(clipById(mover.id).track).toBe(0);
    expect(clipById(mover.id).start).toBeCloseTo(2);
    expectLaneSound(videoLane(0));
  });
});

describe("committed video updates (AI chat / inspector)", () => {
  test("a start move into a resident slides to the next free slot", () => {
    const c1 = vclip({ track: 1, start: 0, out: 2 });
    const c2 = vclip({ track: 1, start: 3, out: 2 });
    useEditor.setState({ clips: [c1, c2] });
    s().updateClip(c2.id, { start: 1 });
    expect(clipById(c2.id).start).toBeCloseTo(2);
    expectLaneSound(videoLane(1));
  });

  test("a move only collides with its own track", () => {
    const c1 = vclip({ track: 1, start: 0, out: 2 });
    const c2 = vclip({ track: 2, start: 3, out: 2 });
    useEditor.setState({ clips: [c1, c2] });
    s().updateClip(c2.id, { start: 1 });
    expect(clipById(c2.id).start).toBeCloseTo(1);
  });

  test("retracking onto an occupied track slides clear", () => {
    const c1 = vclip({ track: 1, start: 0, out: 2 });
    const c2 = vclip({ track: 2, start: 0.5, out: 2 });
    useEditor.setState({ clips: [c1, c2] });
    s().updateClip(c2.id, { track: 1 });
    expect(clipById(c2.id).start).toBeCloseTo(2);
    expectLaneSound(videoLane(1));
  });

  test("extending a clip pushes the same-track run right", () => {
    const c1 = vclip({ track: 1, start: 0, out: 2 });
    const c2 = vclip({ track: 1, start: 2.5, out: 2 });
    const c3 = vclip({ track: 1, start: 5, out: 2 });
    useEditor.setState({ clips: [c1, c2, c3] });
    s().updateClip(c1.id, { out: 4 });
    expect(clipById(c2.id).start).toBeCloseTo(4);
    expect(clipById(c3.id).start).toBeCloseTo(6.5); // gap preserved
    expectLaneSound(videoLane(1));
  });

  test("a speed change that lengthens the footprint pushes the run", () => {
    const c1 = vclip({ track: 1, start: 0, out: 2, speed: 2 }); // 1s footprint
    const c2 = vclip({ track: 1, start: 1, out: 2 });
    useEditor.setState({ clips: [c1, c2] });
    s().updateClip(c1.id, { speed: undefined }); // back to 1x → 2s footprint
    expect(clipById(c2.id).start).toBeCloseTo(2);
    expectLaneSound(videoLane(1));
  });

  test("a non-footprint patch moves nothing", () => {
    const c1 = vclip({ track: 1, start: 0, out: 2 });
    const c2 = vclip({ track: 1, start: 2, out: 2 });
    useEditor.setState({ clips: [c1, c2] });
    s().updateClip(c1.id, { muted: true });
    expect(clipById(c1.id).start).toBeCloseTo(0);
    expect(clipById(c2.id).start).toBeCloseTo(2);
  });

  test("a declared cross-dissolve is contact, not intrusion", () => {
    const a = vclip({ track: 0, start: 0, out: 4, transition: 1 });
    const b = vclip({ track: 0, start: 3, out: 4 });
    useEditor.setState({ clips: [a, b] });
    // Re-committing the dissolved start must not evict the pair's overlap.
    s().updateClip(b.id, { start: 3 });
    expect(clipById(b.id).start).toBeCloseTo(3);
    // Moving deeper than the declared overlap slides back to contact.
    s().updateClip(b.id, { start: 1 });
    expect(clipById(b.id).start).toBeCloseTo(3);
  });
});

describe("audio lanes", () => {
  test("adding at an occupied time slides right", () => {
    const a = asset(2, "audio");
    useEditor.setState({
      assets: [a],
      audioClips: [aclip({ start: 0, out: 2 })],
    });
    s().addAudioFromAsset(a.id, 1);
    const added = s().audioClips.find((c) => c.assetId === a.id)!;
    expect(added.start).toBeCloseTo(2);
  });

  test("a committed start move slides on its own lane only", () => {
    const a1 = aclip({ start: 0, out: 2 });
    const a2 = aclip({ start: 3, out: 2 });
    const other = aclip({ start: 1, out: 2, lane: 1 });
    useEditor.setState({ audioClips: [a1, a2, other] });
    s().updateAudio(a2.id, { start: 0.5 });
    expect(audioById(a2.id).start).toBeCloseTo(2);
    expect(audioById(other.id).start).toBeCloseTo(1); // other lane untouched
  });

  test("retracking to another lane lands on a free slot there", () => {
    const a1 = aclip({ start: 0, out: 2 });
    const a2 = aclip({ start: 0.5, out: 2, lane: 1 });
    useEditor.setState({ audioClips: [a1, a2] });
    s().updateAudio(a2.id, { lane: undefined });
    expect(audioById(a2.id).start).toBeCloseTo(2);
  });

  test("extending pushes the same-lane run right", () => {
    const a1 = aclip({ start: 0, out: 2 });
    const a2 = aclip({ start: 2.5, out: 2 });
    useEditor.setState({ audioClips: [a1, a2] });
    s().updateAudio(a1.id, { out: 4 });
    expect(audioById(a2.id).start).toBeCloseTo(4);
  });

  test("volume/fade patches move nothing", () => {
    const a1 = aclip({ start: 0, out: 2 });
    const a2 = aclip({ start: 2, out: 2 });
    useEditor.setState({ audioClips: [a1, a2] });
    s().updateAudio(a1.id, { volume: 0.4, fadeIn: 0.5 });
    expect(audioById(a1.id).start).toBeCloseTo(0);
    expect(audioById(a2.id).start).toBeCloseTo(2);
  });
});

describe("title lanes", () => {
  const overlayById = (id: string) => s().overlays.find((o) => o.id === id)!;

  test("a committed start move slides clear, keeping its length", () => {
    const t1 = title({ start: 0, end: 2 });
    const t2 = title({ start: 3, end: 4 });
    useEditor.setState({ overlays: [t1, t2] });
    s().updateOverlay(t2.id, { start: 1 });
    expect(overlayById(t2.id).start).toBeCloseTo(2);
    expect(overlayById(t2.id).end).toBeCloseTo(3);
  });

  test("growing the end pushes the same-lane run right", () => {
    const t1 = title({ start: 0, end: 2 });
    const t2 = title({ start: 2.5, end: 4 });
    useEditor.setState({ overlays: [t1, t2] });
    s().updateOverlay(t1.id, { end: 3 });
    expect(overlayById(t2.id).start).toBeCloseTo(3);
    expect(overlayById(t2.id).end).toBeCloseTo(4.5); // length kept
  });

  test("lanes are independent", () => {
    const t1 = title({ start: 0, end: 2 });
    const t2 = title({ start: 3, end: 4, lane: 1 });
    useEditor.setState({ overlays: [t1, t2] });
    s().updateOverlay(t2.id, { start: 0.5 });
    expect(overlayById(t2.id).start).toBeCloseTo(0.5);
  });
});

describe("subtitle cues", () => {
  test("retiming slides past occupied stretches and drops word timings", () => {
    const q1 = cue({ start: 0, end: 1 });
    const q2 = cue({ start: 2, end: 3, words: [{ t0: 2, t1: 3, w: "hi" }] });
    useEditor.setState({
      subtitles: { ...emptySubtitles(), cues: [q1, q2] },
    });
    s().setCueTiming(q2.id, 0.5, 1.5);
    const next = s().subtitles.cues.find((c) => c.id === q2.id)!;
    expect(next.start).toBeCloseTo(1);
    expect(next.end).toBeCloseTo(2);
    expect(next.words).toBeUndefined();
  });

  test("retiming on another lane ignores this lane's cues", () => {
    const q1 = cue({ start: 0, end: 1 });
    const q2 = cue({ start: 2, end: 3, lane: 1 });
    useEditor.setState({
      subtitles: { ...emptySubtitles(), cues: [q1, q2] },
    });
    s().setCueTiming(q2.id, 0.5, 1.5);
    const next = s().subtitles.cues.find((c) => c.id === q2.id)!;
    expect(next.start).toBeCloseTo(0.5);
  });
});

describe("delete ripple and gaps", () => {
  test("single-track delete ripples: later items on every track slide left", () => {
    const a = vclip({ track: 0, start: 0, out: 2 });
    const b = vclip({ track: 0, start: 2, out: 2 });
    const au = aclip({ start: 3, out: 2 });
    const t = title({ start: 3, end: 4 });
    useEditor.setState({
      clips: [a, b],
      audioClips: [au],
      overlays: [t],
      selection: { kind: "clip", id: a.id },
    });
    s().deleteSelection();
    expect(clipById(b.id).start).toBeCloseTo(0);
    expect(audioById(au.id).start).toBeCloseTo(1);
    expect(s().overlays[0].start).toBeCloseTo(1);
  });

  test("delete with an overlay video track leaves the gap in place", () => {
    const a = vclip({ track: 0, start: 0, out: 2 });
    const b = vclip({ track: 0, start: 2, out: 2 });
    const layer = vclip({ track: 1, start: 1, out: 2 });
    useEditor.setState({
      clips: [a, b, layer],
      selection: { kind: "clip", id: a.id },
    });
    s().deleteSelection();
    expect(clipById(b.id).start).toBeCloseTo(2);
    expect(clipById(layer.id).start).toBeCloseTo(1);
  });

  test("removeGap closes the gap on its own track only", () => {
    const b = vclip({ track: 0, start: 2, out: 2 });
    const layer = vclip({ track: 1, start: 2.5, out: 2 });
    const au = aclip({ start: 3, out: 2 });
    useEditor.setState({ clips: [b, layer], audioClips: [au] });
    s().removeGap(0, 1);
    expect(clipById(b.id).start).toBeCloseTo(0);
    expect(clipById(layer.id).start).toBeCloseTo(2.5);
    expect(audioById(au.id).start).toBeCloseTo(3);
  });

  test("removeGap between clips on an upper track slides only that track", () => {
    const base = vclip({ track: 0, start: 0, out: 2 });
    const l1 = vclip({ track: 1, start: 0, out: 1 });
    const l2 = vclip({ track: 1, start: 3, out: 1 });
    useEditor.setState({ clips: [base, l1, l2] });
    s().removeGap(1, 2);
    expect(clipById(l2.id).start).toBeCloseTo(1);
    expect(clipById(base.id).start).toBeCloseTo(0);
  });

  test("removeGap outside a gap is a no-op", () => {
    const a = vclip({ track: 0, start: 0, out: 2 });
    const b = vclip({ track: 0, start: 3, out: 2 });
    useEditor.setState({ clips: [a, b] });
    s().removeGap(0, 1); // on a clip
    s().removeGap(0, 6); // past the end
    expect(clipById(a.id).start).toBeCloseTo(0);
    expect(clipById(b.id).start).toBeCloseTo(3);
  });
});

describe("spine grounding", () => {
  test("deleting the last track-0 clip grounds the layers above it", () => {
    const spine = vclip({ track: 0, start: 0, out: 2 });
    const layer = vclip({ track: 1, start: 2, out: 2 });
    const upper = vclip({ track: 2, start: 2.5, out: 2 });
    useEditor.setState({
      clips: [spine, layer, upper],
      selection: { kind: "clip", id: spine.id },
    });
    s().deleteSelection();
    expect(clipById(layer.id).track).toBe(0);
    expect(clipById(upper.id).track).toBe(1);
  });

  test("dragging the only track-0 clip up onto a layer grounds the stack", () => {
    const mover = vclip({ track: 0, start: 0, out: 2 });
    const resident = vclip({ track: 1, start: 1, out: 2 });
    useEditor.setState({ clips: [mover, resident] });
    s().dropVideoClip(mover.id, { kind: "track", track: 1 }, 1.2);
    expect(clipById(mover.id).track).toBe(0);
    expect(clipById(resident.id).track).toBe(0);
    expectLaneSound(videoLane(0));
  });
});

describe("upper-track transitions", () => {
  test("setClipTransition on an upper track pulls the pair into overlap contact", () => {
    const av = asset(4);
    const bv = asset(4);
    const spine = vclip({ track: 0, start: 0, out: 4 });
    const a = vclip({ track: 1, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 1, start: 4, out: 4, assetId: bv.id });
    useEditor.setState({ assets: [av, bv], clips: [spine, a, b] });
    s().setClipTransition(a.id, 1);
    expect(clipById(a.id).transition).toBeCloseTo(1);
    expect(clipById(b.id).start).toBeCloseTo(3); // slid into the dissolve
    expect(clipById(spine.id).start).toBeCloseTo(0); // track 0 untouched
  });

  test("setClipTransition slides only its own track's run", () => {
    const av = asset(4);
    const spine1 = vclip({ track: 0, start: 0, out: 4 });
    const spine2 = vclip({ track: 0, start: 4, out: 4 });
    const a = vclip({ track: 1, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 1, start: 4, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [spine1, spine2, a, b] });
    s().setClipTransition(a.id, 1);
    expect(clipById(b.id).start).toBeCloseTo(3);
    expect(clipById(spine2.id).start).toBeCloseTo(4);
  });

  test("splitting a layer clip clears the left half's transition", () => {
    const av = asset(8);
    const spine = vclip({ track: 0, start: 0, out: 8 });
    const a = vclip({ track: 1, start: 0, out: 8, transition: 1, assetId: av.id });
    useEditor.setState({
      assets: [av],
      clips: [spine, a],
      selection: { kind: "clip", id: a.id },
      currentTime: 4,
    });
    s().splitAtPlayhead();
    const halves = s().clips.filter((c) => c.track === 1);
    expect(halves.length).toBe(2);
    const left = halves.find((c) => c.start === 0)!;
    const right = halves.find((c) => c.start === 4)!;
    expect(left.transition).toBeUndefined();
    expect(right.transition).toBe(1);
  });
});

describe("transitioned joints own their edges", () => {
  test("setting a transition clears the animations adjacent to its joint", () => {
    const av = asset(4);
    const a = vclip({
      track: 0,
      start: 0,
      out: 4,
      assetId: av.id,
      animIn: { style: "fade", seconds: 0.5 },
      animOut: { style: "slideleft", seconds: 0.5 },
    });
    const b = vclip({
      track: 0,
      start: 4,
      out: 4,
      assetId: av.id,
      animIn: { style: "pop", seconds: 0.5 },
      animOut: { style: "fade", seconds: 0.5 },
    });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipTransition(a.id, 0.8, "pushdown");
    // The joint's own edges clear; the far edges stay.
    expect(clipById(a.id).animOut).toBeUndefined();
    expect(clipById(b.id).animIn).toBeUndefined();
    expect(clipById(a.id).animIn).toEqual({ style: "fade", seconds: 0.5 });
    expect(clipById(b.id).animOut).toEqual({ style: "fade", seconds: 0.5 });
  });

  test("clearing a transition leaves the neighbors' animations alone", () => {
    const av = asset(4);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id, transition: 0.8 });
    const b = vclip({
      track: 0,
      start: 3.2,
      out: 4,
      assetId: av.id,
      animOut: { style: "fade", seconds: 0.5 },
    });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipTransition(a.id, 0);
    expect(clipById(a.id).transition).toBeUndefined();
    expect(clipById(b.id).animOut).toEqual({ style: "fade", seconds: 0.5 });
  });
});

describe("last pick wins per edge", () => {
  test("an entrance animation on the following clip replaces the joint's transition", () => {
    const av = asset(4);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 4, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipTransition(a.id, 0.8, "pushdown");
    expect(clipById(b.id).start).toBeCloseTo(3.2);
    s().setClipAnim(b.id, "in", { style: "slideleft", seconds: 0.5 });
    expect(clipById(a.id).transition).toBeUndefined();
    expect(clipById(b.id).start).toBeCloseTo(4); // back to a hard cut
    expect(clipById(b.id).animIn).toEqual({ style: "slideleft", seconds: 0.5 });
  });

  test("an exit animation on the leading clip replaces the joint's transition", () => {
    const av = asset(4);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 4, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipTransition(a.id, 0.8, "circleopen");
    s().setClipAnim(a.id, "out", { style: "fade", seconds: 0.4 });
    expect(clipById(a.id).transition).toBeUndefined();
    expect(clipById(a.id).animOut).toEqual({ style: "fade", seconds: 0.4 });
    expect(clipById(b.id).start).toBeCloseTo(4);
  });

  test("an animation on a far edge leaves an unrelated transition alone", () => {
    const av = asset(4);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 4, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipTransition(a.id, 0.8);
    s().setClipAnim(a.id, "in", { style: "fade", seconds: 0.5 }); // A's entrance, not the joint
    s().setClipAnim(b.id, "out", { style: "fade", seconds: 0.5 }); // B's exit, not the joint
    expect(clipById(a.id).transition).toBeCloseTo(0.8);
    expect(clipById(a.id).animIn).toEqual({ style: "fade", seconds: 0.5 });
    expect(clipById(b.id).animOut).toEqual({ style: "fade", seconds: 0.5 });
  });
});

describe("generated-scene placement (placeInRun)", () => {
  const span = (id: string, start: number, end: number) => ({ id, start, end });

  test("with no run neighbors it slides right past residents", () => {
    const { start, shifts } = placeInRun([span("u1", 0, 4)], 2, 3, new Set());
    expect(start).toBeCloseTo(4);
    expect(shifts).toEqual([]);
  });

  test("never slides past a later shot's clip — pushes it right instead", () => {
    const row = [span("u1", 0, 4), span("s2", 4, 8), span("u2", 8, 10)];
    const { start, shifts } = placeInRun(row, 0, 4, new Set(["s2"]));
    expect(start).toBeCloseTo(4); // slid clear of the resident, not past s2
    // s2 and everything after it open the slot as one run.
    expect(shifts).toEqual([
      { id: "s2", start: 8 },
      { id: "u2", start: 12 },
    ]);
  });

  test("out-of-order landings assemble gapless in shot order on an empty track", () => {
    const row: { id: string; start: number; end: number }[] = [];
    const p3 = placeInRun(row, 15, 5, new Set());
    row.push(span("s3", p3.start, p3.start + 5));
    const p1 = placeInRun(row, 0, 8, new Set(["s3"]));
    expect(p1.start).toBeCloseTo(0);
    expect(p1.shifts).toEqual([]);
    row.push(span("s1", 0, 8));
    const p2 = placeInRun(row, 8, 7, new Set(["s3"])); // want = live end of s1
    expect(p2.start).toBeCloseTo(8);
    expect(p2.shifts).toEqual([]);
  });

  test("placeGenClip anchors after the run's earlier clip when the plan's frames are stale", () => {
    const av = asset(4);
    const user = vclip({ start: 0, out: 4, assetId: "x" });
    const s1 = vclip({ start: 4, out: 4, assetId: "x" });
    useEditor.setState({ assets: [av], clips: [user, s1] });
    // Planned [4, 8) went stale when the user's clip pushed the run to 4..8.
    const id = s().placeGenClip(av.id, 4, 8, { anchorAfterIds: [s1.id] })!;
    expect(clipById(id).start).toBeCloseTo(8);
    expectLaneSound(videoLane(0));
  });

  test("placeGenClip pushes a later shot's clip instead of landing on or past it", () => {
    const av = asset(4);
    const user = vclip({ start: 0, out: 4, assetId: "x" });
    const s2 = vclip({ start: 4, out: 4, assetId: "x" });
    useEditor.setState({ assets: [av], clips: [user, s2] });
    const id = s().placeGenClip(av.id, 0, 4, { followClipIds: [s2.id] })!;
    expect(clipById(id).start).toBeCloseTo(4); // after the resident
    expect(clipById(s2.id).start).toBeCloseTo(8); // pushed, still after the new take
    expectLaneSound(videoLane(0));
  });

  test("placeGenAudio slides to its lane's next free slot", () => {
    const aa = asset(4, "audio");
    const resident = aclip({ start: 0, out: 4, assetId: "x" });
    useEditor.setState({ assets: [aa], audioClips: [resident] });
    const id = s().placeGenAudio(aa.id, 1, 4)!;
    expect(audioById(id).start).toBeCloseTo(4);
  });
});
