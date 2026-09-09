import { beforeEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";

beforeEach(() => {
  useEditor.setState({
    clips: [], overlays: [], transitions: [], audioClips: [],
    assets: [{ id: "voice", fileName: "voice.m4a", name: "Voice", type: "audio", duration: 10, url: "" },
      { id: "music", fileName: "music.m4a", name: "Music", type: "audio", duration: 20, url: "" }],
  });
});

test("assistant can place narration and music together on separate lanes", async () => {
  await runAiTool("add_clip", { asset_id: "voice", start: 0, lane: 0 });
  await runAiTool("add_clip", { asset_id: "music", start: 0, lane: 1 });
  expect(useEditor.getState().audioClips.map((a) => [a.start, a.lane ?? 0])).toEqual([[0, 0], [0, 1]]);
});

test("assistant can repair music appended after narration in one edit", async () => {
  await runAiTool("add_clip", { asset_id: "voice", start: 0 });
  await runAiTool("add_clip", { asset_id: "music", start: 0 });
  const music = useEditor.getState().audioClips.find((a) => a.assetId === "music")!;
  expect(music.start).toBe(10);
  await runAiTool("update_audio", { id: music.id, lane: 1, start: 0, volume: 0.15 });
  const repaired = useEditor.getState().audioClips.find((a) => a.id === music.id)!;
  expect([repaired.start, repaired.lane, repaired.volume]).toEqual([0, 1, 0.15]);
});

test("assistant refuses invalid audio lane indices", async () => {
  for (const lane of [-1, 1.5, Infinity]) {
    const error = await runAiTool("add_clip", { asset_id: "music", lane }).catch((cause: unknown) => cause);
    expect(error instanceof Error && error.message.includes("non-negative integer")).toBe(true);
  }
  expect(useEditor.getState().audioClips).toHaveLength(0);
});
