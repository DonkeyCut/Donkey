import { beforeEach, expect, test } from "bun:test";
import { TIMELINE_TOOLS } from "@/cut/components/Timeline.tools";
import { runAiTool } from "./aiTools";
import { buildAiContext } from "./aiContext";
import { useEditor } from "./store";
import { REGION_MAX_SCALE, emptySubtitles } from "./types";

/**
 * update_overlay_video's custom region: x/y its centre and w/h its size. A
 * box may run past the frame's edges, as the preview's drag handles allow, so
 * a screen in the shot that spills off the frame can be covered by the region
 * itself; the result names the sides it runs past.
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
    assets: [{ id: "a1", fileName: "rec.mov", name: "Rec", type: "video", duration: 10, url: "" }],
  });
  await runAiTool("add_clip", { asset_id: "a1" });
  await runAiTool("add_overlay_video", { asset_id: "a1", start: 0 });
});

const overlay = () => useEditor.getState().clips.find((c) => c.track > 0)!;

test("a region can hang past the frame's sides", async () => {
  await runAiTool("update_overlay_video", { id: overlay().id, region: { x: 0.5, y: 0.475, w: 1.04, h: 0.37 } });
  const f = overlay().frame!;
  expect(f.x).toBeCloseTo(-0.02, 6);
  expect(f.y).toBeCloseTo(0.29, 6);
  expect(f.w).toBe(1.04);
  expect(f.h).toBe(0.37);
});

// x/y are the box's centre, as titles, shapes and the measuring tools take
// them: a diagram boxed at the middle of the frame lands centred.
test("a region's x/y name its centre", async () => {
  const out = (await runAiTool("update_overlay_video", {
    id: overlay().id,
    region: { x: 0.5, y: 0.25, w: 0.75, h: 0.4 },
  })) as { region: unknown; offFrame?: unknown };
  const f = overlay().frame!;
  expect(f.x).toBeCloseTo(0.125, 6);
  expect(f.y).toBeCloseTo(0.05, 6);
  expect(out.region).toEqual({ x: 0.5, y: 0.25, w: 0.75, h: 0.4 });
  expect(out.offFrame).toBeUndefined();
});

test("the result names the sides a box runs past", async () => {
  const out = (await runAiTool("update_overlay_video", {
    id: overlay().id,
    region: { x: 0.75, y: 0.5, w: 0.75, h: 0.4 },
  })) as { offFrame?: Record<string, number> };
  expect(out.offFrame).toEqual({ right: 0.125 });
});

test("a region stays within the oversize ceiling and keeps a sliver on the frame", async () => {
  await runAiTool("update_overlay_video", { id: overlay().id, region: { x: -9, y: 5, w: 10, h: 0.01 } });
  const f = overlay().frame!;
  expect(f.w).toBe(REGION_MAX_SCALE);
  expect(f.h).toBe(0.05);
  // At least part of the box still overlaps the frame.
  expect(f.x + f.w).toBeGreaterThan(0);
  expect(f.y).toBeLessThan(1);
});

test("layout and region together are refused", async () => {
  expect(
    runAiTool("update_overlay_video", { id: overlay().id, layout: "pip", region: { x: 0.5, y: 0.5, w: 0.8, h: 0.5 } })
  ).rejects.toThrow("not both");
});

test("the region schema says it may pass the frame edges", () => {
  const tool = TIMELINE_TOOLS.find((t) => t.name === "update_overlay_video")!;
  const region = (tool.inputSchema as { properties: Record<string, { properties: Record<string, { description: string }> }> })
    .properties.region;
  expect(region.properties.x.description).toContain("past");
  expect(region.properties.w.description).toContain(String(REGION_MAX_SCALE));
});

// The box is measured to a pixel of a 1080 frame; editor_state reads it back
// at that precision so the chat can confirm what it set.
test("editor_state reads a layer's region back at the precision it was set", async () => {
  await runAiTool("update_overlay_video", { id: overlay().id, region: { x: -0.0126, y: 0.2877, w: 1.0131, h: 0.3771 } });
  const layer = JSON.stringify(buildAiContext({ chatId: null }));
  expect(layer).toContain('"region":{"x":-0.0126,"y":0.2877,"w":1.0131,"h":0.3771}');
});
