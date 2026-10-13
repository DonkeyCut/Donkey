import { beforeEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import type { AudioClip, Overlay } from "./types";

// Built a piece at a time, a cut ends up a lane per sound and a row per
// element: the chat once had to step 15 rows down one update at a time to
// close them up, and could not read the result back to check it.

const sound = (id: string, start: number, len: number, lane: number): AudioClip => ({ id, assetId: "a", start, in: 0, out: len, volume: 1, lane });
const shape = (id: string, start: number, end: number, lane: number): Overlay =>
  ({ id, kind: "shape", shape: "rect", start, end, x: 0.5, y: 0.5, w: 0.2, h: 0.2, fill: "#fff", lane }) as Overlay;
const flash = (id: string, start: number, end: number, lane: number): Overlay =>
  ({ id, kind: "effect", effect: "flash", start, end, x: 0.5, y: 0.5, lane }) as Overlay;

beforeEach(() => {
  useEditor.setState({
    clips: [], transitions: [], overlays: [], audioClips: [],
    assets: [{ id: "a", fileName: "a.mp3", name: "a", type: "audio", duration: 30, url: "" }],
  });
});

const laneOf = (id: string) => {
  const s = useEditor.getState();
  return ([...s.audioClips, ...s.overlays].find((x) => x.id === id)!.lane ?? 0);
};

test("sounds that never overlap close up onto one lane; overlapping ones keep two", async () => {
  useEditor.setState({ audioClips: [sound("s1", 0, 3, 0), sound("s2", 5, 1, 2), sound("s3", 6.5, 1, 3), sound("s4", 9, 20, 1), sound("s5", 10, 1, 4)] });
  const res = (await runAiTool("pack_lanes", {})) as { soundtrack: { before: number; after: number } };
  expect(res.soundtrack).toEqual({ before: 5, after: 2 });
  expect(["s1", "s2", "s3", "s4", "s5"].map(laneOf)).toEqual([0, 0, 0, 0, 1]);
});

test("elements keep the front-to-back order of every overlapping pair, and effects keep their own rows", async () => {
  useEditor.setState({
    overlays: [
      flash("fx", 0, 1, 0),
      shape("title", 2, 4, 3),
      shape("plate", 2, 4, 6),
      shape("later", 5, 6, 8),
      flash("fx2", 5, 6, 7),
    ],
  });
  const res = (await runAiTool("pack_lanes", { band: "elements" })) as { elements: { before: number; after: number } };
  expect(laneOf("fx")).toBe(laneOf("fx2"));
  expect(laneOf("title")).toBeLessThan(laneOf("plate"));
  expect(laneOf("later")).not.toBe(laneOf("fx2"));
  expect(res.elements).toEqual({ before: 5, after: 3 });
});

test("an already packed timeline is left alone", async () => {
  useEditor.setState({ audioClips: [sound("s1", 0, 3, 0)] });
  const res = (await runAiTool("pack_lanes", {})) as { moved: number };
  expect(res.moved).toBe(0);
});
