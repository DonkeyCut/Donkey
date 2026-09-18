import { beforeEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";

// The apply half of a sweep: one call over a list of ids, landing as one
// undo step, with the shortfall reported rather than swallowed.

beforeEach(async () => {
  useEditor.setState({
    clips: [],
    overlays: [],
    transitions: [],
    audioClips: [],
    assets: [
      { id: "a1", fileName: "one.mp4", name: "One", type: "video", duration: 5, url: "" },
      { id: "a2", fileName: "two.mp4", name: "Two", type: "video", duration: 5, url: "" },
      { id: "a3", fileName: "three.mp4", name: "Three", type: "video", duration: 5, url: "" },
    ],
  });
  for (const id of ["a1", "a2", "a3"]) await runAiTool("add_clip", { asset_id: id });
});

const clipIds = () => useEditor.getState().clips.map((c) => c.id);

test("one call mutes every id and reports them at the top level", async () => {
  const ids = clipIds();
  const out = (await runAiTool("set_clip_muted", { ids, muted: true })) as { ran: number; ids: string[] };
  expect(out.ran).toBe(3);
  expect(out.ids).toEqual(ids);
  expect(useEditor.getState().clips.every((c) => c.muted)).toBe(true);
});

test("the whole sweep is one undo step", async () => {
  await runAiTool("set_clip_muted", { ids: clipIds(), muted: true });
  useEditor.getState().undo();
  expect(useEditor.getState().clips.some((c) => c.muted)).toBe(false);
});

test("an id that does not land is named beside the ones that did", async () => {
  const ids = clipIds();
  const out = (await runAiTool("set_clip_muted", { ids: [...ids, "gone"], muted: true })) as {
    ran: number;
    ids: string[];
    failed: { id: string }[];
  };
  expect(out.ran).toBe(3);
  expect(out.ids).toEqual(ids);
  expect(out.failed.map((f) => f.id)).toEqual(["gone"]);
});

test("a sweep where nothing lands throws", async () => {
  await expect(runAiTool("set_clip_muted", { ids: ["nope", "also-nope"], muted: true })).rejects.toThrow(
    /None of those 2/,
  );
});

test("a call naming no target is refused, and naming both is too", async () => {
  await expect(runAiTool("set_clip_muted", { muted: true })).rejects.toThrow(/needs clipId/);
  await expect(runAiTool("delete_cue", {})).rejects.toThrow(/needs id/);
  await expect(runAiTool("set_clip_muted", { clipId: clipIds()[0], ids: clipIds(), muted: true })).rejects.toThrow(
    /not both/,
  );
});
