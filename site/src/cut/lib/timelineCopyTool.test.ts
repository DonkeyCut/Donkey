import { beforeEach, expect, test } from "bun:test";
import { buildAiContext } from "./aiContext";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import type { AudioClip, MediaAsset } from "./types";

// Asked to put Main's music on Second, the chat laid the music file down
// whole: Second had no view of Main's soundtrack clip, and nothing it could
// call copied one. Main's clip is trimmed and mixed, and the copy is that clip.

const music: MediaAsset = { id: "music", fileName: "music.m4a", name: "Music", type: "audio", duration: 23.47, url: "" };
const bed: AudioClip = { id: "bed", assetId: "music", start: 0, in: 0, out: 23.4, volume: 0.4, fadeIn: 0.5, fadeOut: 2 };

beforeEach(async () => {
  await useEditor.getState().openProjectDoc("copy", { name: "Copy" }, [music]);
  useEditor.setState({ assets: [music], audioClips: [bed] });
  useEditor.getState().switchTimeline("second", { ownAspect: true });
});

test("the snapshot carries a parked timeline's soundtrack with its trims", () => {
  const { project } = buildAiContext() as { project: { timelines: { id: string; soundtrack?: unknown[] }[] } };
  const main = project.timelines.find((t) => t.id === "main")!;
  expect(main.soundtrack).toHaveLength(1);
  expect(main.soundtrack![0]).toMatchObject({ id: "bed", asset: "Music", start: 0, in: 0, out: 23.4, volume: 0.4, fadeIn: 0.5, fadeOut: 2 });
});

test("get_state reads a parked timeline's items", async () => {
  const read = (await runAiTool("get_state", { timeline: "main", sections: ["soundtrack"] })) as {
    timeline: string;
    soundtrack: { id: string; out: number }[];
  };
  expect(read.timeline).toBe("main");
  expect(read.soundtrack.map((a) => [a.id, a.out])).toEqual([["bed", 23.4]]);
});

test("copy_from_timeline lays Main's soundtrack clip on Second as Main has it", async () => {
  await runAiTool("copy_from_timeline", { timeline: "main", ids: ["bed"], at: 1.5 });
  const s = useEditor.getState();
  expect(s.audioClips).toHaveLength(1);
  const [copy] = s.audioClips;
  expect(copy).toMatchObject({ assetId: "music", start: 1.5, in: 0, out: 23.4, volume: 0.4, fadeIn: 0.5, fadeOut: 2 });
  expect(copy.id).not.toBe("bed");
  // Main keeps its own clip.
  expect(s.timelines.main?.audioClips.map((a) => a.id)).toEqual(["bed"]);
});

test("copy_from_timeline keeps the source's timing when no time is given", async () => {
  useEditor.getState().switchTimeline("main", { ownAspect: true });
  useEditor.getState().updateAudio("bed", { start: 3 });
  useEditor.getState().switchTimeline("second", { ownAspect: true });
  await runAiTool("copy_from_timeline", { timeline: "main", ids: ["bed"] });
  expect(useEditor.getState().audioClips[0].start).toBe(3);
});

test("copy_from_timeline names the ids it could not find", async () => {
  const error = await runAiTool("copy_from_timeline", { timeline: "main", ids: ["nope"] }).catch((e: unknown) => e);
  expect(error instanceof Error && error.message.includes("nope")).toBe(true);
});

// Asked for Main's music at 5.5 s on lane 1 beside a click on lane 0, the copy
// took the source's lane 0, slid past the click to 6.117 s, and the result
// read as if it landed where asked.

const clickAsset: MediaAsset = { id: "click-file", fileName: "click.wav", name: "Click", type: "audio", duration: 0.9, url: "" };
const click: AudioClip = { id: "click", assetId: "click-file", start: 5.217, in: 0, out: 0.9, volume: 1, fadeIn: 0, fadeOut: 0 };

// Second holds the click on lane 0 before each copy.
function seedClick() {
  useEditor.setState((s) => ({ assets: [...s.assets, clickAsset], audioClips: [click] }));
}

test("copy_from_timeline lands on the asked lane at the asked time", async () => {
  seedClick();
  const result = (await runAiTool("copy_from_timeline", { timeline: "main", ids: ["bed"], at: 5.5, lane: 1 })) as {
    copied: { start: number; askedStart?: number }[];
  };
  const copy = useEditor.getState().audioClips.find((a) => a.assetId === "music")!;
  expect(copy).toMatchObject({ start: 5.5, lane: 1 });
  expect(result.copied[0].start).toBe(5.5);
  expect(result.copied[0].askedStart).toBeUndefined();
});

test("copy_from_timeline says when a copy slid past a taken spot", async () => {
  seedClick();
  const result = (await runAiTool("copy_from_timeline", { timeline: "main", ids: ["bed"], at: 5.5 })) as {
    copied: { start: number; askedStart?: number; why?: string }[];
  };
  const [item] = result.copied;
  expect(item.start).toBe(6.117);
  expect(item.askedStart).toBe(5.5);
  expect(item.why).toContain("click");
});
