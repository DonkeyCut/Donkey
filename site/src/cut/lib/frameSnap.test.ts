import { beforeEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";

// The tools report times to the millisecond — frame 22 at 60 fps is 0.367 —
// and the model writes them back as it read them. A time that sits a third of
// a millisecond past its frame shows the frame before it, so every time a tool
// takes lands on the frame it names: exactly k/fps, the time a render asks for.

/** Frame k at `fps`, as the render's clock asks for it. */
const frame = (k: number, fps = 60) => k / fps;
/** A frame's time as a tool reports it: to the millisecond. */
const ms = (t: number) => Math.round(t * 1000) / 1000;

beforeEach(() => {
  useEditor.setState({
    clips: [],
    overlays: [],
    transitions: [],
    audioClips: [],
    assets: [
      { id: "v", fileName: "v.mp4", name: "Footage", type: "video", duration: 60, url: "" },
      { id: "song", fileName: "song.mp3", name: "Song", type: "audio", duration: 60, url: "" },
    ],
  });
});

test("an element written to the millisecond starts and ends on its frames", async () => {
  await runAiTool("add_shape", { shape: "rect", start: ms(frame(22)), end: ms(frame(83)) });
  const o = useEditor.getState().overlays[0]!;
  expect(o.start).toBe(frame(22));
  expect(o.end).toBe(frame(83));
});

test("a clip's start, in and out written to the millisecond land on their frames", async () => {
  await runAiTool("add_clip", { asset_id: "v", start: 0 });
  const id = useEditor.getState().clips[0]!.id;
  await runAiTool("trim_clip", { clipId: id, in: ms(frame(7)), out: ms(frame(301)) });
  await runAiTool("place_clip", { clipId: id, start: ms(frame(41)) });
  const c = useEditor.getState().clips[0]!;
  expect(c.in).toBe(frame(7));
  expect(c.out).toBe(frame(301));
  expect(c.start).toBe(frame(41));
});

test("a sound's start written to the millisecond lands on its frame", async () => {
  await runAiTool("add_clip", { asset_id: "song", start: ms(frame(13)) });
  const a = useEditor.getState().audioClips[0]!;
  expect(a.start).toBe(frame(13));
  await runAiTool("update_audio", { id: a.id, start: ms(frame(97)) });
  expect(useEditor.getState().audioClips[0]!.start).toBe(frame(97));
});

test("a split written to the millisecond cuts on its frame", async () => {
  await runAiTool("add_clip", { asset_id: "v", start: 0 });
  await runAiTool("split_at", { t: ms(frame(22)) });
  const starts = useEditor.getState().clips.map((c) => c.start).sort((a, b) => a - b);
  expect(starts).toEqual([0, frame(22)]);
});

test("keyframes written to the millisecond sit on their frames", async () => {
  await runAiTool("add_shape", { shape: "rect", start: 0, end: 4 });
  const id = useEditor.getState().overlays[0]!.id;
  await runAiTool("set_overlay_keyframes", { id, keys: [{ t: ms(frame(1)), x: 0.2 }, { t: ms(frame(23)), x: 0.8 }] });
  const keys = useEditor.getState().overlays[0]!.kf ?? [];
  expect(keys.map((k) => k.t)).toEqual([frame(1), frame(23)]);
});

/** Where a shape written to start at `t` starts. */
async function shapeStart(t: number): Promise<number> {
  useEditor.setState({ overlays: [] });
  const { id } = (await runAiTool("add_shape", { shape: "rect", start: t, end: 5 })) as { id: string };
  return useEditor.getState().overlays.find((o) => o.id === id)!.start;
}

test("the snap never moves a time between frames at 24, 25, 30, 50 or 60 fps", async () => {
  // Every frame of every common rate, written to the millisecond, lands on
  // itself; times that are not on a frame stay where they were written.
  for (const fps of [24, 25, 30, 50, 60]) {
    for (let k = 0; k < fps * 3; k++) {
      expect(await shapeStart(ms(frame(k, fps)))).toBe(frame(k, fps));
    }
  }
  for (const t of [0.3672, 1.2345, 2.0009]) {
    expect(await shapeStart(t)).toBe(t);
  }
});
