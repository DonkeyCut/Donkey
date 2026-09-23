import { beforeEach, expect, test } from "bun:test";
import { movePreviewSelection, previewSelectionSnapshot, rotatePreviewSelection, scalePreviewSelection } from "@/cut/lib/previewSelection";
import { useEditor } from "@/cut/lib/store";
import { emptySubtitles, type TextOverlay, type VideoClip } from "@/cut/lib/types";
import { runAiTool } from "@/cut/lib/aiTools";
import { setPlayhead } from "@/cut/lib/playhead";

const title = (id: string, x: number, y: number): TextOverlay => ({
  id, text: id, start: 0, end: 4, x, y, size: 60, font: "sf", weight: 700,
  color: "#fff", shadow: false, plate: false,
});
const clip: VideoClip = { id: "video", assetId: "asset", track: 0, start: 0, in: 0, out: 4, muted: true, frame: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } };
const st = () => useEditor.getState();
beforeEach(() => {
  setPlayhead(1);
  useEditor.setState({ clips: [], assets: [], overlays: [], audioClips: [], transitions: [], subtitles: emptySubtitles(), selection: null, multiSelection: [] });
});

test("timeline selection moves mixed visuals together and undoes as one edit", () => {
  useEditor.setState({ overlays: [title("a", 0.4, 0.4), title("b", 0.6, 0.6), title("untouched", 0.2, 0.2)], clips: [clip] });
  st().setMultiSelection([{ kind: "overlay", id: "a" }, { kind: "overlay", id: "b" }, { kind: "clip", id: "video" }]);
  const before = st();
  const snapshot = previewSelectionSnapshot(before, 1);
  st().pushHistory();
  movePreviewSelection(st(), snapshot, 0.05, 0.05);
  movePreviewSelection(st(), snapshot, 0.1, 0.2);
  expect(st().overlays[0].x).toBeCloseTo(0.5);
  expect(st().overlays[1].x).toBeCloseTo(0.7);
  expect(st().overlays[1].y - st().overlays[0].y).toBeCloseTo(0.2);
  expect(st().clips[0].frame?.x).toBeCloseTo(0.2);
  expect(st().overlays[2]).toEqual(before.overlays[2]);
  expect(st().multiSelection).toEqual(before.multiSelection);
  st().undo();
  expect(st().overlays).toEqual(before.overlays);
  expect(st().clips[0].frame).toEqual(before.clips[0].frame);
});

test("clamping preserves the spacing of the entire selection", () => {
  useEditor.setState({ overlays: [title("a", 0.5, 0.3), title("b", 0.9, 0.6)] });
  st().setMultiSelection([{ kind: "overlay", id: "a" }, { kind: "overlay", id: "b" }]);
  movePreviewSelection(st(), previewSelectionSnapshot(st(), 1), 0.5, -0.5);
  expect(st().overlays[1].x).toBeCloseTo(0.98);
  expect(st().overlays[1].x - st().overlays[0].x).toBeCloseTo(0.4);
  expect(st().overlays[0].y).toBeCloseTo(0.02);
  expect(st().overlays[1].y - st().overlays[0].y).toBeCloseTo(0.3);
});

test("keyed items move from their evaluated poses while retaining other keys", () => {
  const keys = [{ t: 0, x: 0.2, y: 0.3, scale: 1, rotation: 30, opacity: 0.8 }, { t: 2, x: 0.6, y: 0.5, scale: 2, rotation: 60, opacity: 1 }];
  useEditor.setState({ overlays: [{ ...title("a", 0.5, 0.5), kf: keys }], clips: [{ ...clip, kf: keys }] });
  st().setMultiSelection([{ kind: "overlay", id: "a" }, { kind: "clip", id: "video" }]);
  movePreviewSelection(st(), previewSelectionSnapshot(st(), 1), 0.1, 0.1);
  for (const item of [st().overlays[0], st().clips[0]]) {
    expect(item.kf).toHaveLength(3);
    expect(item.kf?.[0]).toEqual(keys[0]);
    expect(item.kf?.[2]).toEqual(keys[1]);
    expect(item.kf?.[1].x).toBeCloseTo(0.5);
    expect(item.kf?.[1].y).toBeCloseTo(0.5);
    expect(item.kf?.[1].rotation).toBeCloseTo(45);
    expect(item.kf?.[1].scale).toBeCloseTo(1.5);
  }
});

test("multiple cues on a track move its shared anchor once", () => {
  useEditor.setState({ overlays: [title("a", 0.3, 0.4)], subtitles: { ...emptySubtitles(), tracks: [{ x: 0.4, y: 0.6 }], cues: [{ id: "q1", start: 0, end: 1, text: "one" }, { id: "q2", start: 1, end: 2, text: "two" }] } });
  st().setMultiSelection([{ kind: "overlay", id: "a" }, { kind: "cue", id: "q1" }, { kind: "cue", id: "q2" }]);
  const snapshot = previewSelectionSnapshot(st(), 1);
  expect(snapshot).toHaveLength(2);
  movePreviewSelection(st(), snapshot, 0.1, 0.1);
  expect(st().subtitles.tracks?.[0].x).toBeCloseTo(0.5);
  expect(st().subtitles.cues[0].start).toBe(0);
});

test("chat can add, move, and remove preview selections", async () => {
  useEditor.setState({ overlays: [title("a", 0.3, 0.4), title("b", 0.6, 0.7)] });
  await runAiTool("select", { kind: "overlay", id: "a" });
  await runAiTool("select", { kind: "overlay", id: "b", additive: true });
  expect(st().multiSelection).toHaveLength(2);
  await runAiTool("move_selection", { dx: 0.1, dy: 0.1 });
  expect(st().overlays[0].x).toBeCloseTo(0.4);
  expect(st().overlays[1].x).toBeCloseTo(0.7);
  await runAiTool("select", { kind: "overlay", id: "a", additive: true });
  expect(st().multiSelection).toEqual([{ kind: "overlay", id: "b" }]);
});

test("scaling grows what each kind stores about the anchor", () => {
  useEditor.setState({
    overlays: [title("a", 0.4, 0.4), { id: "box", kind: "shape", shape: "rect", start: 0, end: 4, x: 0.6, y: 0.6, w: 0.2, h: 0.1, fill: "#fff" }],
    clips: [clip],
  });
  st().setMultiSelection([{ kind: "overlay", id: "a" }, { kind: "overlay", id: "box" }, { kind: "clip", id: "video" }]);
  const snapshot = previewSelectionSnapshot(st(), 1);
  scalePreviewSelection(st(), snapshot, { x: 0.2, y: 0.2 }, 2, 2);
  expect(st().overlays[0].x).toBeCloseTo(0.6);
  expect((st().overlays[0] as TextOverlay).size).toBeCloseTo(120);
  expect(st().overlays[1].x).toBeCloseTo(0.98);
  expect((st().overlays[1] as { w: number }).w).toBeCloseTo(0.4);
  expect(st().clips[0].frame).toEqual({ x: 0.0, y: 0.0, w: 0.6, h: 0.6 });
  scalePreviewSelection(st(), snapshot, { x: 0.2, y: 0.2 }, 2, 1);
  expect((st().overlays[0] as TextOverlay).size).toBe(60);
  expect((st().overlays[0] as TextOverlay).stretchX).toBeCloseTo(2);
});

test("rotating orbits every center and turns every item", () => {
  useEditor.setState({ overlays: [title("a", 0.7, 0.5), title("b", 0.3, 0.5)], clips: [clip] });
  st().setMultiSelection([{ kind: "overlay", id: "a" }, { kind: "overlay", id: "b" }, { kind: "clip", id: "video" }]);
  const snapshot = previewSelectionSnapshot(st(), 1);
  rotatePreviewSelection(st(), snapshot, { x: 0.5, y: 0.5 }, 90, 1);
  expect(st().overlays[0].x).toBeCloseTo(0.5);
  expect(st().overlays[0].y).toBeCloseTo(0.7);
  expect(st().overlays[0].rotation).toBe(90);
  expect(st().overlays[1].y).toBeCloseTo(0.3);
  expect(st().clips[0].rotation).toBe(90);
  expect(st().clips[0].frame!.x + 0.15).toBeCloseTo(0.75);
});
