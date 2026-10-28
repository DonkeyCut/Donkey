import { beforeEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles } from "./types";

/**
 * An overlay over an empty timeline. A stack grounds on its lowest row, so a
 * clip asked onto track 1 with nothing on track 0 became the base clip: a
 * screen recording meant for a laptop's screen took the whole frame, the
 * footage added next went in after it, and the call still said it had worked.
 */

beforeEach(() => {
  useEditor.setState({
    projectId: "p1",
    aspect: "9:16",
    clips: [],
    overlays: [],
    transitions: [],
    audioClips: [],
    subtitles: emptySubtitles(),
    assets: [
      { id: "desk", fileName: "desk.mov", name: "Desk", type: "video", duration: 60, url: "" },
      { id: "rec", fileName: "rec.mp4", name: "Recording", type: "video", duration: 29, url: "" },
    ],
  });
});

test("an overlay with nothing on track 0 is refused, naming the clip to add first", async () => {
  expect(runAiTool("add_overlay_video", { asset_id: "rec", start: 0, track: 1 })).rejects.toThrow("add_clip");
  expect(useEditor.getState().clips).toHaveLength(0);
});

test("over a clip on track 0 it lands on the track asked", async () => {
  await runAiTool("add_clip", { asset_id: "desk" });
  const out = (await runAiTool("add_overlay_video", { asset_id: "rec", start: 0, track: 1 })) as { track: number };
  expect(out.track).toBe(1);
});
