import { beforeEach, expect, test } from "bun:test";
import { GRADE_MAX } from "@donkeycut/effects-kit";
import { stubModule } from "@/lib/testing/stubModule";
import type { LibraryAsset, LibraryData } from "./library";
import type { SavedGrade } from "./gradePresets";
import type { MediaAsset } from "./types";
import { BUILTIN_LUTS } from "./builtinLuts";

// The colour tools: every slider the panel renders, four wheels, the LUT
// off the shelf, one grade copied across the timeline as one undo step, the
// source-colour switch, and the saved grades — the chat surface of the
// Color panel, kept true to it.

// One LUT on the shelf, listed the way the registry lists a lazy kind: off
// its row's content key, with no bytes read.
const shelf: LibraryAsset[] = [
  {
    id: "l1",
    fileName: "kodak.cube",
    name: "Kodak 2383",
    type: "lut",
    duration: 0,
    addedAt: 1,
    residency: "cloud",
    contentKey: "kodak",
    lut: { kind: "3d", size: 33 },
  },
];
await stubModule<typeof import("./library")>("./library", import.meta.url, {
  fetchLibrary: async (): Promise<LibraryData> => ({ assets: shelf, folders: [], templates: [] }),
});
await stubModule<typeof import("./cache")>("./cache", import.meta.url, {
  readSnapshot: async () => null,
  writeSnapshot: () => {},
});

const shelfGrades: SavedGrade[] = [];
await stubModule<typeof import("./gradePresets")>("./gradePresets", import.meta.url, {
  listSavedGrades: async () => shelfGrades,
  saveGradePreset: async (_projectId, name, grade) => {
    const saved: SavedGrade = { id: `g${shelfGrades.length + 1}`, name, residency: "browser", grade: grade! };
    shelfGrades.push(saved);
    return saved;
  },
});

// A flat mid-grey frame stands in for a decoded clip frame, so the stats
// tool reads known pixels.
await stubModule<typeof import("./baseFrame")>("./baseFrame", import.meta.url, {
  sampleClipBaseFrameData: (_clipId, w = 96, h = 54) => new Uint8ClampedArray(w * h * 4).fill(128),
});

const { runAiTool } = await import("./aiTools");
const { useEditor } = await import("./store");
const { syncLinkedLibrary } = await import("./linkedLibrary");
await syncLinkedLibrary();

const LOG_ASSET: MediaAsset = {
  id: "a1",
  fileName: "log.mov",
  name: "Log",
  type: "video",
  duration: 5,
  url: "",
  color: { matrix: "bt2020nc", fullRange: false, bitDepth: 10, detected: "apple-log" },
};

beforeEach(async () => {
  shelfGrades.length = 0;
  useEditor.setState({
    projectId: "p1",
    clips: [],
    overlays: [],
    transitions: [],
    audioClips: [],
    assets: [
      LOG_ASSET,
      { id: "a2", fileName: "two.mp4", name: "Two", type: "video", duration: 5, url: "" },
      { id: "a3", fileName: "three.mp4", name: "Three", type: "video", duration: 5, url: "" },
    ],
  });
  for (const id of ["a1", "a2", "a3"]) await runAiTool("add_clip", { asset_id: id });
});

const clips = () => useEditor.getState().clips;
const clipIds = () => clips().map((c) => c.id);
const gradeOf = (id: string) => clips().find((c) => c.id === id)?.grade;

test("set_color_grade takes every basic and detail slider, clamped to its range", async () => {
  const [id] = clipIds();
  await runAiTool("set_color_grade", {
    clipId: id,
    whites: 10,
    blacks: -5,
    brilliance: 20,
    fade: -30,
    sharpen: 80,
    clarity: 15,
  });
  expect(gradeOf(id)).toEqual({ whites: 10, blacks: -5, brilliance: 20, sharpen: GRADE_MAX, clarity: 15 });
});

test("set_color_grade all_clips lands one patch on the whole timeline as one undo step", async () => {
  const out = (await runAiTool("set_color_grade", { all_clips: true, exposure: 12 })) as { ran: number; ids: string[] };
  expect(out.ran).toBe(3);
  expect(out.ids).toEqual(clipIds());
  expect(clips().every((c) => c.grade?.exposure === 12)).toBe(true);
  useEditor.getState().undo();
  expect(clips().every((c) => !c.grade)).toBe(true);
});

test("set_color_wheels writes the offset wheel and still reads the older zone names", async () => {
  const [id] = clipIds();
  await runAiTool("set_color_wheels", { clipId: id, offset: { dx: 5, dy: -5, luma: 2 }, shadows: { dx: 1, dy: 0, luma: 0 } });
  expect(gradeOf(id)?.wheels).toEqual({ o: [5, -5, 2], s: [1, 0, 0] });
  await runAiTool("set_color_wheels", { clipId: id, lift: { dx: 3, dy: 3, luma: 0 } });
  expect(gradeOf(id)?.wheels).toEqual({ o: [5, -5, 2], s: [3, 3, 0] });
});

test("set_color_curves knows no fade: only curve_contrast writes the master curve", async () => {
  const [id] = clipIds();
  await runAiTool("set_color_curves", { clipId: id, fade: 30 });
  expect(gradeOf(id)).toBeUndefined();
  await runAiTool("set_color_curves", { clipId: id, curve_contrast: 20 });
  expect(gradeOf(id)?.curves?.m?.length).toBeGreaterThan(1);
});

test("set_color_lut names a shelf LUT, keeps its amount, and takes it off again", async () => {
  const [id] = clipIds();
  await expect(runAiTool("set_color_lut", { clipId: id, lut: "lut:nope" })).rejects.toThrow(/No LUT/);
  await runAiTool("set_color_lut", { clipId: id, lut: "lut:kodak", amount: 0.5 });
  expect(gradeOf(id)?.lut).toEqual({ id: "lut:kodak", amount: 0.5 });
  await runAiTool("set_color_grade", { clipId: id, reset: true, exposure: 3 });
  expect(gradeOf(id)).toEqual({ exposure: 3, lut: { id: "lut:kodak", amount: 0.5 } });
  await runAiTool("set_color_lut", { clipId: id, lut: "none" });
  expect(gradeOf(id)).toEqual({ exposure: 3 });
});

test("set_color_lut takes a built-in LUT by the id editor_state lists", async () => {
  const [id] = clipIds();
  const vivid = `lut:${BUILTIN_LUTS.find((l) => l.id === "vivid")!.key}`;
  await runAiTool("set_color_lut", { clipId: id, lut: vivid });
  expect(gradeOf(id)?.lut).toEqual({ id: vivid });
});

test("copy_color_grade puts one clip's whole grade on every other clip, one undo step", async () => {
  const [a, b, c] = clipIds();
  await runAiTool("set_color_lut", { clipId: a, lut: "lut:kodak" });
  await runAiTool("set_color_grade", { clipId: a, exposure: 4, fade: 10 });
  const out = (await runAiTool("copy_color_grade", { clipId: a, all_clips: true })) as { ids: string[] };
  expect(out.ids).toEqual([b, c]);
  expect(gradeOf(c)).toEqual({ exposure: 4, fade: 10, lut: { id: "lut:kodak" } });
  useEditor.getState().undo();
  expect(gradeOf(b)).toBeUndefined();
  expect(gradeOf(c)).toBeUndefined();
  await expect(runAiTool("copy_color_grade", { clipId: a })).rejects.toThrow(/ids|all_clips/);
});

test("set_source_color overrides the detected profile on the clip's asset, with undo", async () => {
  const [id] = clipIds();
  const out = (await runAiTool("set_source_color", { clipId: id, profile: "rec709" })) as { profile: string; detected: string };
  expect(out).toMatchObject({ profile: "rec709", detected: "apple-log" });
  expect(useEditor.getState().assets[0].colorProfile).toBe("rec709");
  useEditor.getState().undo();
  expect(useEditor.getState().assets[0].colorProfile).toBeUndefined();
  await runAiTool("set_source_color", { assetId: "a1", profile: "hlg" });
  await runAiTool("set_source_color", { assetId: "a1", profile: "auto" });
  expect(useEditor.getState().assets[0].colorProfile).toBeUndefined();
  await expect(runAiTool("set_source_color", { assetId: "a1", profile: "cineon" })).rejects.toThrow(/profile must be/);
});

test("save_color_grade keeps the grade under a name and apply_saved_grade puts it on clips", async () => {
  const [a, b, c] = clipIds();
  await expect(runAiTool("save_color_grade", { clipId: a, name: "Warm" })).rejects.toThrow(/neutral/);
  await runAiTool("set_color_grade", { clipId: a, temperature: 15 });
  const saved = (await runAiTool("save_color_grade", { clipId: a, name: "Warm" })) as { id: string; name: string };
  expect(saved.name).toBe("Warm");
  const out = (await runAiTool("apply_saved_grade", { ids: [b, c], preset_id: "warm" })) as { ran: number };
  expect(out.ran).toBe(2);
  expect(gradeOf(c)).toEqual({ temperature: 15 });
  await expect(runAiTool("apply_saved_grade", { clipId: b, preset_id: "cold" })).rejects.toThrow(/No saved grade/);
});

test("read_color_stats reads the base frame, and graded:true reads it through the clip's grade", async () => {
  const [, id] = clipIds();
  await runAiTool("set_color_grade", { clipId: id, temperature: 40 });
  type Stats = { warmth: number };
  const base = (await runAiTool("read_color_stats", { clipId: id })) as Stats;
  const graded = (await runAiTool("read_color_stats", { clipId: id, graded: true })) as Stats;
  expect(base.warmth).toBe(1);
  expect(graded.warmth).toBeGreaterThan(1.05);
});
