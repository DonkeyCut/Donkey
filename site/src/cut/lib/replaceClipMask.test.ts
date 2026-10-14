import { beforeEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import type { VideoClip } from "./types";

// A pen mask cut to a laptop's screen is a region of the frame: swapping in a new screen recording dropped it,
// and the chat had to draw the four corners back on.

const screen = { kind: "pen" as const, points: [{ x: -0.5, y: -0.18 }, { x: 0.5, y: -0.18 }, { x: 0.5, y: 0.17 }, { x: -0.48, y: 0.18 }], feather: 0 };

beforeEach(() => {
  useEditor.setState({
    overlays: [], transitions: [], audioClips: [],
    assets: [
      { id: "old", fileName: "old.mov", name: "old", type: "video", duration: 37, url: "" },
      { id: "new", fileName: "new.mov", name: "new", type: "video", duration: 37, url: "" },
    ],
    clips: [],
  });
});

const clip = (mask: VideoClip["mask"]): VideoClip =>
  ({ id: "c", assetId: "old", start: 0, in: 0, out: 30, track: 1, fit: "fill", mask }) as VideoClip;

test("a mask named as the layer's region stays on the clip when its media is replaced", async () => {
  useEditor.setState({ clips: [clip(screen)] });
  await runAiTool("replace_item", { id: "c", asset_id: "new", keep_mask: true });
  expect(useEditor.getState().clips[0].mask).toEqual(screen);
});

test("without keep_mask the mask goes with the old picture", async () => {
  useEditor.setState({ clips: [clip(screen)] });
  await runAiTool("replace_item", { id: "c", asset_id: "new" });
  expect(useEditor.getState().clips[0].mask).toBeUndefined();
});
