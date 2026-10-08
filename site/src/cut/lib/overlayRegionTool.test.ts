import { beforeEach, expect, test } from "bun:test";
import { TIMELINE_TOOLS } from "@/cut/components/Timeline.tools";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { REGION_MAX_SCALE, emptySubtitles } from "./types";

/**
 * update_overlay_video's custom region: a box may run past the frame's
 * edges, as the preview's drag handles allow, so a screen in the shot that
 * spills off the frame can be covered by the region itself.
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
  await runAiTool("update_overlay_video", { id: overlay().id, region: { x: -0.02, y: 0.29, w: 1.04, h: 0.37 } });
  expect(overlay().frame).toEqual({ x: -0.02, y: 0.29, w: 1.04, h: 0.37 });
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

test("the region schema says it may pass the frame edges", () => {
  const tool = TIMELINE_TOOLS.find((t) => t.name === "update_overlay_video")!;
  const region = (tool.inputSchema as { properties: Record<string, { properties: Record<string, { description: string }> }> })
    .properties.region;
  expect(region.properties.x.description).toContain("past");
  expect(region.properties.w.description).toContain(String(REGION_MAX_SCALE));
});
