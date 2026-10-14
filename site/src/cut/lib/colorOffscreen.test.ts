import { beforeEach, expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";

/** A clip's colour is read even when it isn't on screen: the frame is decoded
 * from its file at the middle of its trim, so grading a whole timeline never
 * waits on the playhead visiting each clip. */

const decoded: { url: string; time: number; width?: number; height?: number }[] = [];

// Nothing is on screen; the file decode answers a flat dark frame.
await stubModule<typeof import("./baseFrame")>("./baseFrame", import.meta.url, {
  sampleClipRawFrame: () => null,
  rawFrameAt: async (url, time, size) => {
    decoded.push({ url, time, width: size.width, height: size.height });
    const w = size.width ?? 16;
    const h = size.height ?? 9;
    // Each file is two greys 40 apart, pixel by pixel: "blob:one" dark
    // (20 and 60), any other mid (100 and 140).
    const base = url === "blob:one" ? 20 : 100;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < w * h; j++) data.fill(base + (j % 2) * 40, j * 4, j * 4 + 3), (data[j * 4 + 3] = 255);
    return { px: data, recipe: { profile: "rec709", output: "sdr", size: 0 } };
  },
});

const { runAiTool } = await import("./aiTools");
const { useEditor } = await import("./store");

beforeEach(async () => {
  decoded.length = 0;
  useEditor.setState({
    projectId: "p1",
    clips: [],
    overlays: [],
    transitions: [],
    audioClips: [],
    assets: [{ id: "a1", fileName: "one.mp4", name: "One", type: "video", duration: 10, url: "blob:one" }],
  });
  await runAiTool("add_clip", { asset_id: "a1" });
  const [clip] = useEditor.getState().clips;
  useEditor.getState().updateClip(clip.id, { in: 2, out: 6 });
});

test("read_color_stats decodes an off-screen clip's frame from its file, mid-trim", async () => {
  const [clip] = useEditor.getState().clips;
  const stats = (await runAiTool("read_color_stats", { clipId: clip.id })) as { meanR: number };
  expect(stats.meanR).toBe(40);
  expect(decoded).toHaveLength(1);
  expect(decoded[0]).toMatchObject({ url: "blob:one", time: 4 });
});

test("match_color_grade grades an off-screen clip with no seek", async () => {
  const [clip] = useEditor.getState().clips;
  // The clip is its own reference: nothing to change, but no seek error.
  const out = (await runAiTool("match_color_grade", { clipId: clip.id, ref_clip_id: clip.id })) as { id: string };
  expect(out.id).toBe(clip.id);
  expect(decoded.length).toBeGreaterThanOrEqual(1);
});

test("set_color_grade auto fits a grade off an off-screen clip", async () => {
  const [clip] = useEditor.getState().clips;
  await runAiTool("set_color_grade", { clipId: clip.id, auto: true });
  expect(decoded[0]).toMatchObject({ time: 4 });
  expect(useEditor.getState().clips[0].grade?.exposure).toBeGreaterThan(0);
});

test("match_color_grade strength takes the match part of the way", async () => {
  useEditor.setState({
    assets: [...useEditor.getState().assets, { id: "a2", fileName: "two.mp4", name: "Two", type: "video", duration: 10, url: "blob:two" }],
  });
  await runAiTool("add_clip", { asset_id: "a2" });
  const [dark, mid] = useEditor.getState().clips;
  const exposure = () => useEditor.getState().clips.find((c) => c.id === dark.id)!.grade?.exposure ?? 0;
  await runAiTool("match_color_grade", { clipId: dark.id, ref_clip_id: mid.id });
  const full = exposure();
  expect(full).toBeGreaterThan(10);
  await runAiTool("match_color_grade", { clipId: dark.id, ref_clip_id: mid.id, strength: 0.5 });
  expect(Math.abs(exposure() - full / 2)).toBeLessThanOrEqual(1);
});

test("strength 0 says it took none of the match", async () => {
  const clip = useEditor.getState().clips[0];
  const out = (await runAiTool("match_color_grade", { clipId: clip.id, ref_clip_id: clip.id, strength: 0 })) as { note?: string };
  expect(out.note).toContain("strength 0");
});
