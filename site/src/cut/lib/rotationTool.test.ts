import { beforeEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles } from "./types";

/**
 * The chat's rotation inputs keep tenths of a degree: a laptop in the shot
 * leans a fraction of a degree, and a screen recording fitted onto its display
 * has to lean the same.
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
  // The first lands on the empty main track, the second above it.
  await runAiTool("add_overlay_video", { asset_id: "a1", start: 0 });
  await runAiTool("add_overlay_video", { asset_id: "a1", start: 0 });
});

const overlay = () => useEditor.getState().clips.find((c) => c.track > 0)!;

test("an overlay video keeps a fractional rotation", async () => {
  await runAiTool("update_overlay_video", { id: overlay().id, rotation: 0.4 });
  expect(overlay().rotation).toBe(0.4);
  await runAiTool("update_overlay_video", { id: overlay().id, rotation: -0.66 });
  expect(overlay().rotation).toBe(-0.7);
  await runAiTool("update_overlay_video", { id: overlay().id, rotation: 0.04 });
  expect(overlay().rotation).toBeUndefined();
});

test("a clip pose key keeps a fractional rotation", async () => {
  await runAiTool("set_clip_keyframes", { clipId: overlay().id, keys: [{ t: 0, scale: 1.04, rotation: 0.4 }] });
  expect(overlay().kf?.[0].rotation).toBe(0.4);
});

test("an overlay element keeps a fractional rotation", async () => {
  await runAiTool("add_shape", { shape: "rect", start: 0, end: 2 });
  const id = useEditor.getState().overlays[0].id;
  await runAiTool("update_overlay", { id, rotation: -2.36 });
  expect(useEditor.getState().overlays[0].rotation).toBe(-2.4);
});
