import { beforeEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { buildAiContext } from "./aiContext";
import { useEditor } from "./store";
import { emptySubtitles } from "./types";

/**
 * Stills over a talking head: add_overlay_video's length for an image, and
 * set_animation's answer when a neighbour on the track takes the bar. A
 * chart dropped near the close used to run its 8s default past the cut's
 * end, and charts laid end to end lost their entrances without a word.
 */

beforeEach(async () => {
  useEditor.setState({
    projectId: "p1",
    aspect: "9:16",
    clips: [],
    overlays: [],
    transitions: [],
    audioClips: [],
    subtitles: emptySubtitles(),
    assets: [
      { id: "talk", fileName: "talk.mov", name: "Talk", type: "video", duration: 20, url: "" },
      { id: "chart", fileName: "chart.jpg", name: "Chart", type: "image", duration: 0, width: 2000, height: 1125, url: "" },
      { id: "chart2", fileName: "chart2.jpg", name: "Chart 2", type: "image", duration: 0, width: 2000, height: 1125, url: "" },
    ],
  });
  await runAiTool("add_clip", { asset_id: "talk" });
});

const clip = (id: string) => useEditor.getState().clips.find((c) => c.id === id)!;
const end = (id: string) => clip(id).start + (clip(id).out - clip(id).in);

test("an image near the close stops where track 0 does", async () => {
  const out = (await runAiTool("add_overlay_video", { asset_id: "chart", start: 17 })) as { id: string; end: number };
  expect(end(out.id)).toBeCloseTo(20, 6);
  expect(out.end).toBe(20);
});

test("end sets an image's length", async () => {
  const out = (await runAiTool("add_overlay_video", { asset_id: "chart", start: 4, end: 7.5 })) as { id: string; len: number };
  expect(end(out.id)).toBeCloseTo(7.5, 6);
  expect(out.len).toBe(3.5);
});

// The landing measures the still at the length it asked for, so a clip
// later on the track moves up past it and the two never overlap.
test("an image lands at its asked length without overlapping", async () => {
  const later = (await runAiTool("add_overlay_video", { asset_id: "chart2", start: 6, end: 8 })) as { id: string };
  const out = (await runAiTool("add_overlay_video", { asset_id: "chart", start: 2, end: 9 })) as { id: string };
  expect(end(out.id)).toBeCloseTo(9, 6);
  expect(clip(later.id).start).toBeGreaterThanOrEqual(end(out.id) - 1e-6);
});

test("an end before the start is refused", async () => {
  expect(runAiTool("add_overlay_video", { asset_id: "chart", start: 5, end: 4 })).rejects.toThrow("end must come after");
});

test("set_animation names the neighbour that took the bar", async () => {
  const a = (await runAiTool("add_overlay_video", { asset_id: "chart", start: 2, end: 6 })) as { id: string };
  const b = (await runAiTool("add_overlay_video", { asset_id: "chart2", start: 6, end: 9 })) as { id: string };
  const res = (await runAiTool("set_animation", { clipId: b.id, which: "in", style: "zoom", seconds: 0.3 })) as {
    style: string;
    note?: string;
  };
  expect(res.style).toBe("none");
  expect(res.note).toContain(a.id);
  expect(res.note).toContain("Leave a gap");
});

test("set_animation on a free edge sets the entrance", async () => {
  const a = (await runAiTool("add_overlay_video", { asset_id: "chart", start: 2, end: 6 })) as { id: string };
  const res = (await runAiTool("set_animation", { clipId: a.id, which: "in", style: "zoom", seconds: 0.3 })) as {
    style: string;
    note?: string;
  };
  expect(res.style).toBe("zoom");
  expect(res.note).toBeUndefined();
});

// Safe areas read as every other box does: x/y the centre.
test("safeZones report centre boxes", () => {
  const ctx = buildAiContext({ chatId: null }) as { project: { safeZones: Record<string, { safeArea: { x: number; y: number; w: number; h: number } }> } };
  expect(ctx.project.safeZones.margins.safeArea).toEqual({ x: 0.5, y: 0.5, w: 0.9, h: 0.9 });
});
