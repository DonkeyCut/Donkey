import { beforeEach, describe, expect, test } from "bun:test";
import { groupRemap } from "@donkeycut/effects-kit";
import { adoptTransitionFields, clipLen, deriveTransitionFields, docOverlays, getClipSpans, liftClipLooks, moveOverlayGroup, overlayLaneOrder, normalizeElementLanes, parkedTransitions, placeInRun, projectDuration, reanchorTransitions, separateOverlaps, serializeDoc, useEditor } from "./store";
import { playheadAt, setPlayhead, setSkim } from "./playhead";
import { emptySubtitles } from "./types";
import type { AudioClip, MediaAsset, SubtitleCue, TextOverlay, VideoClip } from "./types";

/**
 * The lane invariant: segments never overlap, with no exceptions. Every
 * placement and committed update — user drops, AI-chat tools, inspector
 * edits — must land items on a free stretch of their lane (video per track,
 * audio/title/cue per lane). A transition is a render-time blend at the cut,
 * never a physical overlap.
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
  setSkim(null);
  useEditor.setState({
    clips: [],
    transitions: [],
    audioClips: [],
    overlays: [],
    assets: [],
    subtitles: emptySubtitles(),
    selection: null,
    multiSelection: [],
  });
});

describe("the document projection", () => {
  // Autosave tells an edit from a re-read by comparing this projection's
  // identity. A projection that rebuilt itself on every read would mark the
  // document dirty forever — and, since saving sets state, feed itself.
  test("re-reading an unchanged document hands back the same arrays", () => {
    useEditor.setState({
      overlays: [title({ kind: "text" }), title({ kind: "text", start: 3, end: 5 })],
    });
    const a = serializeDoc(s() as Parameters<typeof serializeDoc>[0]);
    const b = serializeDoc(s() as Parameters<typeof serializeDoc>[0]);
    expect(b.overlays).toBe(a.overlays!);
    expect(b.clips).toBe(a.clips!);
    expect(docOverlays(s().overlays)).toBe(a.overlays!);
  });

  test("an edit gives a new projection, and the stamp still comes off", () => {
    useEditor.setState({ overlays: [title({ kind: "text" })] });
    const before = serializeDoc(s() as Parameters<typeof serializeDoc>[0]);
    s().updateOverlay(s().overlays[0].id, { x: 0.2 });
    const after = serializeDoc(s() as Parameters<typeof serializeDoc>[0]);
    expect(after.overlays).not.toBe(before.overlays!);
    // Text elements still serialize without the loader's stamp.
    expect("kind" in after.overlays![0]).toBe(false);
  });

  test("a document with nothing to strip is passed straight through", () => {
    const overlays = [
      { id: "s1", kind: "shape", shape: "rect", start: 0, end: 2, x: 0.5, y: 0.5, w: 0.2, h: 0.2, fill: "#fff" },
    ] as unknown as Parameters<typeof docOverlays>[0];
    expect(docOverlays(overlays)).toBe(overlays);
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
    // Grounded on write: the stack always sits on track 0, so the pair is
    // written as the rows they would ground to.
    const c1 = vclip({ track: 0, start: 0, out: 2 });
    const c2 = vclip({ track: 1, start: 0.5, out: 2 });
    useEditor.setState({ clips: [c1, c2] });
    s().updateClip(c2.id, { track: 0 });
    expect(clipById(c2.id).start).toBeCloseTo(2);
    expectLaneSound(videoLane(0));
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

  test("separateOverlaps pulls an old physically-overlapped doc apart", () => {
    // A doc saved when a transition slid clips into each other: b starts
    // inside a, c rides 1s behind b across a gap.
    const a = vclip({ track: 0, start: 0, out: 4, transition: 1 });
    const b = vclip({ track: 0, start: 3, out: 4 });
    const c = vclip({ track: 0, start: 8, out: 2 });
    const other = vclip({ track: 1, start: 3, out: 2 });
    const out = separateOverlaps({
      clips: [a, b, c, other],
      audioClips: [],
      overlays: [],
      cues: [],
    });
    const by = (id: string) => out.clips.find((x) => x.id === id)!;
    expect(by(b.id).start).toBeCloseTo(4); // pushed out to the cut
    expect(by(c.id).start).toBeCloseTo(9); // the run keeps its gap
    expect(by(other.id).start).toBeCloseTo(3); // other tracks untouched
    // A doc with nothing intruding passes through untouched.
    const clean = { clips: [vclip({ start: 0, out: 2 }), vclip({ start: 2, out: 2 })], audioClips: [], overlays: [], cues: [] };
    expect(separateOverlaps(clean)).toBe(clean);
  });

  test("the cut getting longer carries the sound, titles and captions with it", () => {
    // Same doc, now annotated: a voiceover, a title and a caption timed
    // against the shorter overlapped timeline.
    const a = vclip({ track: 0, start: 0, out: 4, transition: 1 });
    const b = vclip({ track: 0, start: 3, out: 4 });
    const out = separateOverlaps({
      clips: [a, b],
      audioClips: [aclip({ start: 0, out: 2 }), aclip({ start: 5, out: 2 })],
      overlays: [title({ start: 1, end: 2 }), title({ start: 4, end: 6 })],
      cues: [cue({ start: 5, end: 6, words: [{ w: "hi", t0: 5, t1: 6 }] })],
    });
    expect(out.clips.find((c) => c.id === b.id)!.start).toBeCloseTo(4);
    // Before the joint nothing moves; after it, everything moves with b.
    expect(out.audioClips[0].start).toBeCloseTo(0);
    expect(out.audioClips[1].start).toBeCloseTo(6);
    expect(out.overlays[0].start).toBeCloseTo(1);
    expect(out.overlays[1].start).toBeCloseTo(5);
    expect(out.cues[0].start).toBeCloseTo(6);
    expect(out.cues[0].words![0].t0).toBeCloseTo(6);
  });

  test("clips never overlap, transition or not", () => {
    const a = vclip({ track: 0, start: 0, out: 4, transition: 1 });
    const b = vclip({ track: 0, start: 4, out: 4 });
    useEditor.setState({ clips: [a, b] });
    // Re-committing the abutting start moves nothing.
    s().updateClip(b.id, { start: 4 });
    expect(clipById(b.id).start).toBeCloseTo(4);
    // A move into the leading clip settles back out to contact — a
    // transition is a blend at the cut, never a licence to intrude.
    s().updateClip(b.id, { start: 1 });
    expect(clipById(b.id).start).toBeCloseTo(4);
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

  describe("group moves", () => {
    test("peers ride along keeping their length and spacing", () => {
      const a = title({ start: 5, end: 7, groupId: "g" });
      const b = title({ start: 9, end: 13, lane: 1, groupId: "g" });
      useEditor.setState({ overlays: [a, b] });
      // The dragged element lands first; the group follows it.
      s().updateOverlaysTransient([{ id: a.id, patch: { start: 6, end: 8 } }]);
      moveOverlayGroup(a, 1);
      expect(overlayById(b.id).start).toBeCloseTo(10);
      expect(overlayById(b.id).end).toBeCloseTo(14); // 4s long, still
    });

    test("a shift past zero moves the whole group, never squashing one", () => {
      const a = title({ start: 5, end: 7, groupId: "g" });
      const b = title({ start: 1, end: 4, lane: 1, groupId: "g" });
      useEditor.setState({ overlays: [a, b] });
      s().updateOverlaysTransient([{ id: a.id, patch: { start: 0, end: 2 } }]);
      moveOverlayGroup(a, -5);
      // b would have gone to -4; the group lands 4 later instead.
      expect(overlayById(b.id).start).toBeCloseTo(0);
      expect(overlayById(b.id).end).toBeCloseTo(3); // 3s long, still
      expect(overlayById(a.id).start).toBeCloseTo(4);
    });

    test("unrelated elements are pushed clear of where the group lands", () => {
      const a = title({ start: 0, end: 2, groupId: "g" });
      const b = title({ start: 0, end: 2, lane: 1, groupId: "g" });
      const resident = title({ start: 4, end: 6, lane: 1 });
      const far = title({ start: 20, end: 21, lane: 1 });
      useEditor.setState({ overlays: [a, b, resident, far] });
      s().updateOverlaysTransient([{ id: a.id, patch: { start: 3.5, end: 5.5 } }]);
      moveOverlayGroup(a, 3.5);
      expect(overlayById(b.id).start).toBeCloseTo(3.5); // rigid
      expect(overlayById(resident.id).start).toBeCloseTo(5.5); // pushed clear
      expect(overlayById(far.id).start).toBeCloseTo(20); // untouched
      expectLaneSound(
        s()
          .overlays.filter((o) => (o.lane ?? 0) === 1)
          .map((o) => ({ start: o.start, end: o.end }))
      );
    });
  });

  describe("keyframes", () => {
    test("a key captures the pose and the track drops when the last one goes", () => {
      const t1 = title({ start: 2, end: 6, x: 0.4, rotation: 30, opacity: 0.5 });
      useEditor.setState({ overlays: [t1] });
      s().setOverlayKey(t1.id, 1);
      const [k] = overlayById(t1.id).kf!;
      expect(k).toEqual({ t: 1, x: 0.4, y: 0.5, scale: 1, rotation: 30, opacity: 0.5 });
      s().removeOverlayKey(t1.id, 1);
      expect(overlayById(t1.id).kf).toBe(undefined);
    });

    test("a key past the element's end clamps into it, and re-keying replaces", () => {
      const t1 = title({ start: 0, end: 3 });
      useEditor.setState({ overlays: [t1] });
      s().setOverlayKey(t1.id, 99, { x: 0.9 });
      expect(overlayById(t1.id).kf![0].t).toBeCloseTo(3);
      s().setOverlayKey(t1.id, 3, { x: 0.1 });
      expect(overlayById(t1.id).kf!.length).toBe(1);
      expect(overlayById(t1.id).kf![0].x).toBeCloseTo(0.1);
    });

    test("a picked key is what Delete takes, and the element stays", () => {
      const t1 = title({ start: 0, end: 4 });
      useEditor.setState({ overlays: [t1] });
      s().setOverlayKey(t1.id, 1, { x: 0.1 });
      s().setOverlayKey(t1.id, 3, { x: 0.9 });
      s().selectOverlayKey(t1.id, 3);
      s().deleteSelection();
      expect(s().overlays.length).toBe(1); // the element is untouched
      expect(overlayById(t1.id).kf!.map((k) => k.t)).toEqual([1]);
      expect(s().selectedKey).toBe(null);
      // With no key picked, Delete goes back to taking the element.
      s().deleteSelection();
      expect(s().overlays.length).toBe(0);
    });

    test("retiming a key carries the pick with it", () => {
      const t1 = title({ start: 0, end: 4 });
      useEditor.setState({ overlays: [t1] });
      s().setOverlayKey(t1.id, 1);
      s().selectOverlayKey(t1.id, 1);
      s().moveOverlayKey(t1.id, 1, 2.5, { transient: true });
      expect(s().selectedKey).toEqual({ kind: "overlay", id: t1.id, t: 2.5, track: "pose" });
      s().deleteSelection();
      expect(overlayById(t1.id).kf).toBe(undefined);
    });

    test("a picked mask key deletes from the mask track and leaves the pose", () => {
      const t1 = title({ start: 0, end: 4, mask: { kind: "rect" as const } });
      useEditor.setState({ overlays: [t1] });
      s().setOverlayKey(t1.id, 1);
      s().setOverlayMaskKey(t1.id, 1);
      s().setOverlayMaskKey(t1.id, 3, { w: 0.8 });
      s().selectOverlayMaskKey(t1.id, 3);
      s().moveOverlayMaskKey(t1.id, 3, 2, { transient: true });
      expect(s().selectedKey).toEqual({ kind: "overlay", id: t1.id, t: 2, track: "mask" });
      s().deleteSelection();
      expect(overlayById(t1.id).mask!.kf!.map((k) => k.t)).toEqual([1]);
      expect(overlayById(t1.id).kf!.length).toBe(1); // the pose track is untouched
    });

    test("selecting anything else drops the pick", () => {
      const t1 = title({ start: 0, end: 4 });
      useEditor.setState({ overlays: [t1] });
      s().setOverlayKey(t1.id, 1);
      s().selectOverlayKey(t1.id, 1);
      s().select({ kind: "overlay", id: t1.id });
      expect(s().selectedKey).toBe(null);
    });

    test("clearing returns the element to its resting pose", () => {
      const t1 = title({ start: 0, end: 4 });
      useEditor.setState({ overlays: [t1] });
      s().setOverlayKey(t1.id, 0, { x: 0.1 });
      s().setOverlayKey(t1.id, 2, { x: 0.9 });
      expect(overlayById(t1.id).kf!.length).toBe(2);
      s().clearOverlayKeys(t1.id);
      expect(overlayById(t1.id).kf).toBe(undefined);
      expect(overlayById(t1.id).x).toBeCloseTo(0.5); // never moved the element itself
    });
  });

  test("copies get their own group, and members copied together stay together", () => {
    let seq = 0;
    const remap = groupRemap(() => `g${++seq}`);
    const a = title({ groupId: "g" });
    const b = title({ groupId: "g" });
    const loner = title({});
    expect(remap(a).groupId).toBe(remap(b).groupId!);
    expect(remap(a).groupId).not.toBe("g");
    expect(remap(loner).groupId).toBe(undefined);
    // A second operation is a second group.
    expect(groupRemap(() => `g${++seq}`)(a).groupId).not.toBe(remap(a).groupId!);
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

  test("a ripple delete carries the transitions and drops the deleted clip's own", () => {
    const av = asset(2);
    const a = vclip({ track: 0, start: 0, out: 2, assetId: av.id });
    const b = vclip({ track: 0, start: 2, out: 2, assetId: av.id });
    const c = vclip({ track: 0, start: 4, out: 2, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b, c] });
    s().setClipTransition(a.id, 0.5);
    s().setClipTransition(b.id, 0.5);
    s().select({ kind: "clip", id: a.id });
    s().deleteSelection();
    // a's own blend goes with it; b's rides the slide and keeps playing.
    expect(s().transitions.length).toBe(1);
    expect(clipById(b.id).start).toBeCloseTo(0);
    expect(clipById(b.id).transition).toBeCloseTo(0.5);
    expect(s().transitions[0].start).toBeCloseTo(1.5);
  });

  test("a trim that pushes the run takes the blends along", () => {
    const av = asset(8);
    const a = vclip({ track: 0, start: 0, in: 0, out: 2, assetId: av.id });
    const b = vclip({ track: 0, start: 2, in: 0, out: 2, assetId: av.id });
    const c = vclip({ track: 0, start: 4, in: 0, out: 2, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b, c] });
    s().setClipTransition(a.id, 0.5);
    s().setClipTransition(b.id, 0.5);
    s().updateClip(a.id, { out: 3 }); // a grows by 1s, pushing b and c right
    expect(clipById(b.id).start).toBeCloseTo(3);
    expect(clipById(a.id).transition).toBeCloseTo(0.5);
    expect(clipById(b.id).transition).toBeCloseTo(0.5);
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

  test("shortening the project pulls the playhead back to the new end", () => {
    // The playhead placed past the end stretched the timeline's scroll area
    // into empty space, because it is positioned with a transform.
    const keep = vclip({ track: 0, start: 0, out: 4 });
    const far = vclip({ track: 0, start: 30, out: 4 });
    useEditor.setState({ clips: [keep, far] });
    s().seek(32);
    expect(playheadAt()).toBeCloseTo(32);
    s().select({ kind: "clip", id: far.id });
    s().deleteSelection();
    expect(playheadAt()).toBeCloseTo(projectDuration(s()));
    expect(playheadAt()).toBeLessThanOrEqual(4);
  });

  test("an overlay left standing keeps the playhead reachable", () => {
    const clip = vclip({ track: 0, start: 0, out: 2 });
    const late = title({ start: 6, end: 9 });
    useEditor.setState({ clips: [clip], overlays: [late], audioClips: [] });
    s().seek(8);
    expect(playheadAt()).toBeCloseTo(8);
  });

  test("removeLaneGap closes the gap on its own track only", () => {
    const b = vclip({ track: 0, start: 2, out: 2 });
    const layer = vclip({ track: 1, start: 2.5, out: 2 });
    const au = aclip({ start: 3, out: 2 });
    useEditor.setState({ clips: [b, layer], audioClips: [au] });
    s().removeLaneGap({ kind: "video", index: 0 }, 1);
    expect(clipById(b.id).start).toBeCloseTo(0);
    expect(clipById(layer.id).start).toBeCloseTo(2.5);
    expect(audioById(au.id).start).toBeCloseTo(3);
  });

  test("removeLaneGap between clips on an upper track slides only that track", () => {
    const base = vclip({ track: 0, start: 0, out: 2 });
    const l1 = vclip({ track: 1, start: 0, out: 1 });
    const l2 = vclip({ track: 1, start: 3, out: 1 });
    useEditor.setState({ clips: [base, l1, l2] });
    s().removeLaneGap({ kind: "video", index: 1 }, 2);
    expect(clipById(l2.id).start).toBeCloseTo(1);
    expect(clipById(base.id).start).toBeCloseTo(0);
  });

  test("removeLaneGap outside a gap is a no-op", () => {
    const a = vclip({ track: 0, start: 0, out: 2 });
    const b = vclip({ track: 0, start: 3, out: 2 });
    useEditor.setState({ clips: [a, b] });
    s().removeLaneGap({ kind: "video", index: 0 }, 1); // on a clip
    s().removeLaneGap({ kind: "video", index: 0 }, 6); // past the end
    expect(clipById(a.id).start).toBeCloseTo(0);
    expect(clipById(b.id).start).toBeCloseTo(3);
  });

  test("removeLaneGap closes an audio row without moving its neighbours", () => {
    const keep = aclip({ start: 0, out: 1 });
    const late = aclip({ start: 3, out: 1 });
    const other = aclip({ start: 3, out: 1, lane: 1 });
    const vid = vclip({ track: 0, start: 3, out: 1 });
    useEditor.setState({ clips: [vid], audioClips: [keep, late, other] });
    s().removeLaneGap({ kind: "audio", index: 0 }, 2);
    expect(audioById(late.id).start).toBeCloseTo(1);
    expect(audioById(other.id).start).toBeCloseTo(3);
    expect(clipById(vid.id).start).toBeCloseTo(3);
  });

  test("removeLaneGap slides a title row and keeps each length", () => {
    const byId = (id: string) => s().overlays.find((o) => o.id === id)!;
    const first = title({ start: 0, end: 1 });
    const late = title({ start: 4, end: 6 });
    const other = title({ start: 4, end: 6, lane: 1 });
    useEditor.setState({ clips: [], overlays: [first, late, other] });
    s().removeLaneGap({ kind: "overlay", index: 0 }, 2);
    expect(byId(late.id).start).toBeCloseTo(1);
    expect(byId(late.id).end).toBeCloseTo(3);
    expect(byId(other.id).start).toBeCloseTo(4);
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
  test("setClipTransition on an upper track moves nothing", () => {
    const av = asset(4);
    const bv = asset(4);
    const spine = vclip({ track: 0, start: 0, out: 4 });
    const a = vclip({ track: 1, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 1, start: 4, out: 4, assetId: bv.id });
    useEditor.setState({ assets: [av, bv], clips: [spine, a, b] });
    s().setClipTransition(a.id, 1);
    expect(clipById(a.id).transition).toBeCloseTo(1);
    expect(clipById(b.id).start).toBeCloseTo(4); // layout untouched
    expect(clipById(spine.id).start).toBeCloseTo(0);
    // The blend is live at the cut the pair already makes.
    const spans = getClipSpans(s().clips, s().assets, 1);
    expect(spans[0].transitionOut).toBeCloseTo(1);
  });

  test("a transition on a gapped pair stays dormant until they touch", () => {
    const av = asset(4);
    const spine = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const a = vclip({ track: 1, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 1, start: 6, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [spine, a, b] });
    s().setClipTransition(a.id, 1);
    expect(clipById(b.id).start).toBeCloseTo(6); // no gap-closing, no motion
    expect(getClipSpans(s().clips, s().assets, 1)[0].transitionOut).toBe(0);
    s().updateClip(b.id, { start: 4 });
    expect(getClipSpans(s().clips, s().assets, 1)[0].transitionOut).toBeCloseTo(1);
  });

  test("splitting a layer clip leaves the tail's transition with the right half", () => {
    const av = asset(8);
    const spine = vclip({ track: 0, start: 0, out: 12 });
    const a = vclip({ track: 1, start: 0, out: 8, assetId: av.id });
    const c = vclip({ track: 1, start: 8, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [spine, a, c] });
    s().setClipTransition(a.id, 1);
    useEditor.setState({ selection: { kind: "clip", id: a.id } });
    setPlayhead(4);
    s().splitAtPlayhead();
    const halves = s().clips.filter((x) => x.track === 1 && x.id !== c.id);
    expect(halves.length).toBe(2);
    const left = halves.find((x) => x.start === 0)!;
    const right = halves.find((x) => x.start === 4)!;
    // The bar sits at the original tail cut, so the right half plays it and
    // the new mid-footage cut stays plain.
    expect(left.transition).toBeUndefined();
    expect(right.transition).toBe(1);
  });
});

describe("bars and clip edges", () => {
  test("a transition and the far-edge animations live together", () => {
    const av = asset(4);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 4, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipAnim(a.id, "in", { style: "fade", seconds: 0.5 });
    s().setClipAnim(b.id, "out", { style: "fade", seconds: 0.5 });
    s().setClipTransition(a.id, 0.8, "pushdown");
    expect(clipById(a.id).transition).toBeCloseTo(0.8);
    expect(clipById(a.id).animIn).toEqual({ style: "fade", seconds: 0.5 });
    expect(clipById(b.id).animOut).toEqual({ style: "fade", seconds: 0.5 });
    // The joint has no open edges, so nothing else can play there.
    expect(clipById(a.id).animOut).toBeUndefined();
    expect(clipById(b.id).animIn).toBeUndefined();
  });

  test("clearing a transition leaves the neighbors' animations alone", () => {
    const av = asset(4);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 4, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipAnim(b.id, "out", { style: "fade", seconds: 0.5 });
    s().setClipTransition(a.id, 0.8);
    s().setClipTransition(a.id, 0);
    expect(clipById(a.id).transition).toBeUndefined();
    expect(clipById(b.id).animOut).toEqual({ style: "fade", seconds: 0.5 });
  });

  test("an entrance picked at a joint parks its bar; the transition keeps playing", () => {
    const av = asset(4);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 4, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipTransition(a.id, 0.8, "pushdown");
    expect(clipById(b.id).start).toBeCloseTo(4); // layout never moves
    s().setClipAnim(b.id, "in", { style: "slideleft", seconds: 0.5 });
    // b's head is a cut, so there is no entrance to make: the bar sits on the
    // row inert and the joint's transition plays on.
    expect(clipById(a.id).transition).toBeCloseTo(0.8);
    expect(clipById(b.id).animIn).toBeUndefined();
    expect(s().transitions.length).toBe(2);
  });

  test("an exit picked at a joint retunes the joint's bar", () => {
    const av = asset(4);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 4, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipTransition(a.id, 0.8, "circleopen");
    s().setClipAnim(a.id, "out", { style: "fade", seconds: 0.4 });
    // The clip's tail IS the joint, so the pick lands on the same bar: it
    // becomes a 0.4s crossfade there, and no second bar appears.
    expect(clipById(a.id).transition).toBeCloseTo(0.4);
    expect(clipById(a.id).transitionStyle).toBeUndefined();
    expect(clipById(a.id).animOut).toBeUndefined();
    expect(s().transitions.length).toBe(1);
    expect(clipById(b.id).start).toBeCloseTo(4);
  });

  test("a pre-bar doc's clip fields become bars once, and derive back unchanged", () => {
    const av = asset(4);
    const a = vclip({
      track: 0,
      start: 0,
      out: 4,
      assetId: av.id,
      transition: 0.8,
      transitionStyle: "pushleft",
      animIn: { style: "fade", seconds: 0.5 },
    });
    const b = vclip({
      track: 0,
      start: 4,
      out: 4,
      assetId: av.id,
      animOut: { style: "zoom", seconds: 0.6 },
    });
    const bars = adoptTransitionFields([a, b], []);
    expect(bars.length).toBe(3);
    const derived = deriveTransitionFields([a, b], bars);
    const da = derived.find((c) => c.id === a.id)!;
    const db = derived.find((c) => c.id === b.id)!;
    expect(da.transition).toBeCloseTo(0.8);
    expect(da.transitionStyle).toBe("pushleft");
    expect(da.animIn).toEqual({ style: "fade", seconds: 0.5 });
    expect(db.animOut).toEqual({ style: "zoom", seconds: 0.6 });
    // A second load adopts nothing new: every field already has its bar.
    expect(adoptTransitionFields(derived, bars)).toBe(bars);
  });

  test("a pre-bar entrance at a joint becomes that joint's blend", () => {
    // The old model let a clip fade in against the previous clip's held frame.
    // A joint carries one blend now, so the entrance becomes it — no bar is
    // left on the row with nothing to play.
    const a = vclip({ track: 0, start: 0, out: 4 });
    const b = vclip({ track: 0, start: 4, out: 4, animIn: { style: "fade", seconds: 0.5 } });
    const bars = adoptTransitionFields([a, b], []);
    expect(bars.length).toBe(1);
    expect(bars[0].start).toBeCloseTo(3.5);
    const derived = deriveTransitionFields([a, b], bars);
    expect(derived.find((c) => c.id === a.id)!.transition).toBeCloseTo(0.5);
    // The joint's own blend outranks it: nothing extra is adopted.
    const withCut = [{ ...a, transition: 0.8 }, b];
    expect(adoptTransitionFields(withCut, []).length).toBe(1);
  });

  test("a bar is not tied to a clip: the pair separating turns its cut into an exit, and moving further parks it", () => {
    const av = asset(4);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 4, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipTransition(a.id, 0.8, "pushdown");
    // The pair separates: the bar stays put, still ends on a's tail — now an
    // open edge — so it plays as a's exit.
    s().updateClipTransient(b.id, { start: 6 });
    expect(clipById(a.id).transition).toBeUndefined();
    expect(clipById(a.id).animOut).toEqual({ style: "slidedown", seconds: 0.8 });
    expect(s().transitions.length).toBe(1);
    // Back together, the cut outranks the exit and the transition returns.
    s().updateClipTransient(b.id, { start: 4 });
    expect(clipById(a.id).transition).toBeCloseTo(0.8);
    expect(clipById(a.id).animOut).toBeUndefined();
    // Both clips gone, the bar survives, aligned with nothing.
    useEditor.setState({ selection: null, multiSelection: [] });
    s().updateClipTransient(a.id, { start: 20 });
    s().updateClipTransient(b.id, { start: 40 });
    expect(s().transitions.length).toBe(1);
    expect(clipById(a.id).transition).toBeUndefined();
  });

  test("a trim carries the bar and the clip fields the export renders from", () => {
    // The preview and the export read clip.transition, not the bar. A resize
    // moves the clip's edge and the run behind it, so both have to land
    // together: a bar left behind, or a field left stale, is a blend playing
    // at a joint that no longer has one.
    const av = asset(8);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 4, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipTransition(a.id, 0.8, "wipeleft");
    s().setClipTrim(a.id, 0, 3);
    // The pair stays in contact, so the cut moved to 3s with the bar on it.
    expect(clipById(b.id).start).toBeCloseTo(3);
    expect(s().transitions[0].start).toBeCloseTo(2.2);
    expect(parkedTransitions(s().clips, s().transitions)).toEqual([]);
    // And the render fields still describe that blend.
    expect(clipById(a.id).transition).toBeCloseTo(0.8);
    expect(clipById(a.id).transitionStyle).toBe("wipeleft");
  });

  test("a bar lining up with nothing reads as parked, and reanchorBars brings it back", () => {
    const av = asset(8);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 6, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    // A blend on a's open tail, the bar ending on 4s.
    s().setClipAnim(a.id, "out", { style: "fade", seconds: 0.8 });
    expect(parkedTransitions(s().clips, s().transitions)).toEqual([]);
    // The clip slides — the move an assistant makes with place_clip — and the
    // bar stays where it was, now lining up with nothing.
    const before = s().clips;
    s().updateClip(a.id, { start: 1 });
    const parked = parkedTransitions(s().clips, s().transitions);
    expect(parked.length).toBe(1);
    expect(parked[0].style).toBe("crossfade");
    expect(clipById(a.id).animOut).toBeUndefined();
    // Carrying the bars through that move lands it back on the edge it
    // played, and the render fields follow.
    s().reanchorBars(before);
    expect(s().transitions[0].start).toBeCloseTo(4.2);
    expect(parkedTransitions(s().clips, s().transitions)).toEqual([]);
    expect(clipById(a.id).animOut).toEqual({ style: "fade", seconds: 0.8 });
  });

  test("a copied bar pastes onto the cut nearest the playhead", () => {
    const av = asset(12);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 4, out: 4, assetId: av.id });
    const c = vclip({ track: 0, start: 8, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b, c] });
    s().setClipTransition(a.id, 0.8, "wipeleft");
    const bar = s().transitions[0];
    useEditor.setState({
      selection: { kind: "transition", id: bar.id },
      multiSelection: [{ kind: "transition", id: bar.id }],
    });
    expect(s().copySelection()).toBe(true);
    setPlayhead(7.7); // in reach of the b|c cut at 8
    expect(s().paste()).toBe(true);
    expect(s().transitions.length).toBe(2);
    // The paste plays that cut with the copied blend, fields and all.
    expect(clipById(b.id).transition).toBeCloseTo(0.8);
    expect(clipById(b.id).transitionStyle).toBe("wipeleft");
    expect(parkedTransitions(s().clips, s().transitions)).toEqual([]);
    expect(s().selection).toEqual({ kind: "transition", id: s().transitions[1].id });
  });

  test("a bar pasted onto an occupied cut replaces the incumbent", () => {
    const av = asset(12);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 4, out: 4, assetId: av.id });
    const c = vclip({ track: 0, start: 8, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b, c] });
    s().setClipTransition(a.id, 0.8, "wipeleft");
    s().setClipTransition(b.id, 0.4, "crossfade");
    const bar = s().transitions.find((t) => t.style === "wipeleft")!;
    useEditor.setState({
      selection: { kind: "transition", id: bar.id },
      multiSelection: [{ kind: "transition", id: bar.id }],
    });
    s().copySelection();
    setPlayhead(8.2);
    s().paste();
    // One bar on the b|c cut: the pasted wipe; the crossfade left with it.
    expect(s().transitions.length).toBe(2);
    expect(clipById(b.id).transition).toBeCloseTo(0.8);
    expect(clipById(b.id).transitionStyle).toBe("wipeleft");
    expect(parkedTransitions(s().clips, s().transitions)).toEqual([]);
  });

  test("a bar pasted far from any boundary parks at the playhead", () => {
    const av = asset(8);
    const a = vclip({ track: 0, start: 0, out: 4, assetId: av.id });
    const b = vclip({ track: 0, start: 4, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipTransition(a.id, 0.6, "dipblack");
    const bar = s().transitions[0];
    useEditor.setState({
      selection: { kind: "transition", id: bar.id },
      multiSelection: [{ kind: "transition", id: bar.id }],
    });
    s().copySelection();
    setPlayhead(6); // 2s from the cuts at 4 and 8
    s().paste();
    expect(s().transitions.length).toBe(2);
    const pasted = s().transitions[1];
    expect(pasted.start).toBeCloseTo(6);
    expect(pasted.style).toBe("dipblack");
    expect(parkedTransitions(s().clips, s().transitions)).toEqual([pasted]);
  });

  test("clips copied with their bar keep the blend on their own cut", () => {
    const av = asset(12);
    const a = vclip({ track: 0, start: 0, out: 3, assetId: av.id });
    const b = vclip({ track: 0, start: 3, out: 3, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipTransition(a.id, 0.5, "crosszoom");
    const bar = s().transitions[0];
    useEditor.setState({
      selection: { kind: "transition", id: bar.id },
      multiSelection: [
        { kind: "clip", id: a.id },
        { kind: "clip", id: b.id },
        { kind: "transition", id: bar.id },
      ],
    });
    expect(s().copySelection()).toBe(true);
    setPlayhead(8);
    expect(s().paste()).toBe(true);
    const pastedClips = s().clips.filter((x) => x.id !== a.id && x.id !== b.id);
    expect(pastedClips.map((x) => x.start)).toEqual([8, 11]);
    // The bar followed the pair, so the copied cut at 11 plays the same blend.
    expect(pastedClips[0].transition).toBeCloseTo(0.5);
    expect(pastedClips[0].transitionStyle).toBe("crosszoom");
    expect(parkedTransitions(s().clips, s().transitions)).toEqual([]);
  });

  test("paste lands under the skimmer when one is live, sliding clear of the lane", () => {
    const av = asset(8);
    const a = vclip({ track: 0, start: 0, out: 3, assetId: av.id });
    useEditor.setState({
      assets: [av],
      clips: [a],
      selection: { kind: "clip", id: a.id },
      multiSelection: [{ kind: "clip", id: a.id }],
    });
    expect(s().copySelection()).toBe(true);
    setPlayhead(10);
    setSkim(5);
    expect(s().paste()).toBe(true);
    // The skimmer wins over the playhead.
    expect(s().clips.map((c) => c.start)).toEqual([0, 5]);
    // A skim into occupied ground slides to the lane's next gap that fits.
    setSkim(1);
    expect(s().paste()).toBe(true);
    expect(s().clips.map((c) => c.start)).toEqual([0, 5, 8]);
    expectLaneSound(videoLane(0));
    // With the pointer off the timeline, the playhead takes over.
    setSkim(null);
    expect(s().paste()).toBe(true);
    expect(s().clips.map((c) => c.start)).toEqual([0, 5, 8, 11]);
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

  test("tracks cutting at the same instant share one bar, never a stack", () => {
    const av = asset(8);
    const a = vclip({ track: 0, start: 0, out: 2, assetId: av.id });
    const b = vclip({ track: 0, start: 2, in: 2, out: 4, assetId: av.id });
    const c = vclip({ track: 1, start: 0, out: 2, assetId: av.id });
    const d = vclip({ track: 1, start: 2, in: 2, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b, c, d] });
    s().setClipTransition(a.id, 0.5);
    s().setClipTransition(c.id, 0.5); // same cut instant on the other track
    expect(s().transitions.length).toBe(1);
    expect(clipById(a.id).transition).toBeCloseTo(0.5);
    expect(clipById(c.id).transition).toBeCloseTo(0.5);
    // Retiming through the same calls updates that one bar in place.
    s().setClipTransition(a.id, 0.4);
    s().setClipTransition(c.id, 0.4);
    expect(s().transitions.length).toBe(1);
    expect(s().transitions[0].seconds).toBeCloseTo(0.4);
  });

  test("simultaneous entrances on several tracks ride one bar", () => {
    const av = asset(8);
    const a = vclip({ track: 1, start: 1, in: 1, out: 3, assetId: av.id });
    const b = vclip({ track: 2, start: 1, in: 1, out: 3, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b] });
    s().setClipAnim(a.id, "in", { style: "zoom", seconds: 0.3 });
    s().setClipAnim(b.id, "in", { style: "zoom", seconds: 0.3 });
    expect(s().transitions.length).toBe(1);
    expect(clipById(a.id).animIn).toEqual({ style: "zoom", seconds: 0.3 });
    expect(clipById(b.id).animIn).toEqual({ style: "zoom", seconds: 0.3 });
  });

  test("deleting a clip takes its parked leftover bars along", () => {
    const av = asset(8);
    const a = vclip({ track: 0, start: 0, out: 2, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a] });
    // A parked twin sitting exactly on the clip's tail, playing nothing.
    s().addTransition({ start: 1.7, seconds: 0.3, style: "crosszoom" });
    s().addTransition({ start: 1.7, seconds: 0.3, style: "crosszoom" });
    expect(s().transitions.length).toBe(2);
    s().select({ kind: "clip", id: a.id });
    s().deleteSelection();
    expect(s().clips.length).toBe(0);
    expect(s().transitions.length).toBe(0);
  });

  test("a shared bar survives while one of its clips does", () => {
    const av = asset(8);
    const a = vclip({ track: 0, start: 0, out: 2, assetId: av.id });
    const b = vclip({ track: 0, start: 2, in: 2, out: 4, assetId: av.id });
    const c = vclip({ track: 1, start: 0, out: 2, assetId: av.id });
    const d = vclip({ track: 1, start: 2, in: 2, out: 4, assetId: av.id });
    useEditor.setState({ assets: [av], clips: [a, b, c, d] });
    s().setClipTransition(a.id, 0.5);
    expect(s().transitions.length).toBe(1);
    // Track 1's pair goes; the bar still plays track 0's cut.
    useEditor.setState({ multiSelection: [{ kind: "clip", id: c.id }, { kind: "clip", id: d.id }] });
    s().deleteSelection();
    expect(s().transitions.length).toBe(1);
    expect(clipById(a.id).transition).toBeCloseTo(0.5);
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

describe("overlay row order", () => {
  const fx = (id: string, start: number, end: number, lane = 0) =>
    ({ id, kind: "effect", effect: "blur", start, end, x: 0.5, y: 0.5, lane }) as unknown as TextOverlay;

  test("rows read in lane order, so a dragged element stays where it was put", () => {
    expect(overlayLaneOrder([title({ lane: 2 }), fx("e1", 0, 2, 0), title({ lane: 1 })])).toEqual([
      0, 1, 2,
    ]);
    // An effect dragged below a title keeps that row: nothing about a kind
    // reorders the band.
    expect(overlayLaneOrder([title({ lane: 0 }), fx("e2", 0, 2, 1)])).toEqual([0, 1]);
  });

  test("loading repairs a shared row and leaves a sound one alone", () => {
    // One shared row: the effect lifts off it and the rows renumber to how
    // they show — the effect on top, the title under it.
    const out = normalizeElementLanes([title({ lane: 0 }), fx("e1", 0, 2)]);
    expect(out.map((o) => o.lane)).toEqual([1, 0]);
    // Two effects overlapping in time cannot share a row, so they take two.
    const pair = normalizeElementLanes([title({ lane: 0 }), fx("e3", 0, 2), fx("e4", 1, 3)]);
    expect(pair.map((o) => o.lane)).toEqual([2, 0, 1]);
    // An effect dragged below a title and saved comes back below it: no
    // shared row, so the load has nothing to repair.
    const dragged = [title({ lane: 0 }), fx("e2", 0, 2, 1)];
    expect(normalizeElementLanes(dragged)).toBe(dragged);
  });

  test("a saved clip look opens as an effect covering that clip", () => {
    const a = asset(4);
    const c1 = vclip({ start: 0, out: 4, assetId: a.id, look: "noir" });
    const c2 = vclip({ start: 4, out: 4, assetId: a.id });
    const spans = [
      { clip: c1, start: 0, len: 4 },
      { clip: c2, start: 4, len: 4 },
    ];
    const out = liftClipLooks([c1, c2], [title({ lane: 0 })], spans)!;
    // The grade covers exactly the clip it graded, on the row above the title.
    const fx = out.overlays.find((o) => o.kind === "effect")!;
    expect([fx.effect, fx.start, fx.end, fx.lane]).toEqual(["noir", 0, 4, 0]);
    expect(out.overlays.find((o) => (o.kind ?? "text") === "text")!.lane).toBe(1);
    // …and the clip no longer carries it, so nothing grades twice.
    expect(out.clips[0].look).toBeUndefined();
    // A doc with no looks is left alone.
    expect(liftClipLooks([c2], [], spans)).toBe(null);
  });

  test("a look saved at full strength lifts at full strength", () => {
    // The old store left lookAmount off at full strength, and an effect with
    // no amount is half — so the lift has to say it.
    const a = asset(4);
    const c = vclip({ start: 0, out: 4, assetId: a.id, look: "noir" });
    const out = liftClipLooks([c], [], [{ clip: c, start: 0, len: 4 }])!;
    expect(out.overlays.find((o) => o.kind === "effect")!.amount).toBe(1);
  });

  test("a graded layer clip keeps its look, which grades that layer alone", () => {
    const a = asset(4);
    const spine = vclip({ track: 0, start: 0, out: 4, assetId: a.id, look: "noir" });
    const layer = vclip({ track: 1, start: 0, out: 2, assetId: a.id, look: "vintage" });
    const out = liftClipLooks([spine, layer], [], [{ clip: spine, start: 0, len: 4 }])!;
    expect(out.overlays.filter((o) => o.kind === "effect").length).toBe(1);
    expect(out.clips.find((c) => c.id === spine.id)!.look).toBeUndefined();
    expect(out.clips.find((c) => c.id === layer.id)!.look).toBe("vintage");
  });

  test("an added effect opens the top row, and later ones join it", () => {
    useEditor.setState({ overlays: [title({ lane: 0 })] });
    s().addEffect("blur");
    const held = useEditor.getState().overlays;
    expect(held.find((o) => o.kind === "effect")!.lane).toBe(0);
    expect(held.find((o) => (o.kind ?? "text") === "text")!.lane).toBe(1); // pushed down a row
    s().addEffect("grain");
    const effectLanes = useEditor
      .getState()
      .overlays.filter((o) => o.kind === "effect")
      .map((o) => o.lane);
    expect(effectLanes).toEqual([0, 0]);
  });

  test("a title added onto an effects-only project takes the row below", () => {
    useEditor.setState({ overlays: [] });
    s().addEffect("blur");
    s().addOverlay();
    const text = useEditor.getState().overlays.find((o) => (o.kind ?? "text") === "text")!;
    expect(text.lane).toBe(1);
    expect(overlayLaneOrder(useEditor.getState().overlays)).toEqual([0, 1]);
  });
});
