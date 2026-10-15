import { beforeEach, expect, test } from "bun:test";
import { buildAiContext } from "./aiContext";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles } from "./types";

// A 60 fps cut changes every 0.0167 s, so the chat reads an element's times to
// the millisecond: at two decimals 0.317 reads 0.32 and it can't confirm the
// frame it placed.

beforeEach(() =>
  useEditor.setState({
    projectId: "p1",
    aspect: "16:9",
    assets: [],
    clips: [],
    audioClips: [],
    overlays: [],
    subtitles: emptySubtitles(),
    background: "#000000",
  })
);

test("a shape's times come back and read to the millisecond", async () => {
  const out = (await runAiTool("add_shape", { shape: "rect", start: 0.317, end: 0.4, lane: 1 })) as { start: number; end: number };
  expect([out.start, out.end]).toEqual([0.317, 0.4]);
  const ctx = buildAiContext() as unknown as { overlays: { start: number; end: number }[] };
  expect([ctx.overlays[0].start, ctx.overlays[0].end]).toEqual([0.317, 0.4]);
});

test("a retime reads back to the millisecond", async () => {
  const { id } = (await runAiTool("add_shape", { shape: "rect", start: 1, end: 2, lane: 1 })) as { id: string };
  const out = (await runAiTool("update_overlay", { id, start: 1.016667, end: 1.233333 })) as { start: number; end: number };
  expect([out.start, out.end]).toEqual([1.017, 1.233]);
});

test("a card shorter than 0.2 s retimes against its neighbour without sliding", async () => {
  const a = (await runAiTool("add_shape", { shape: "rect", start: 0.317, end: 0.4, lane: 1 })) as { id: string };
  const b = (await runAiTool("add_shape", { shape: "rect", start: 0.4, end: 0.567, lane: 1 })) as { id: string };
  const out = (await runAiTool("update_overlay", { id: a.id, start: 0.316667, end: 0.4 })) as { start: number; end: number };
  expect([out.start, out.end]).toEqual([0.317, 0.4]);
  const after = useEditor.getState().overlays.find((o) => o.id === b.id)!;
  expect([after.start, after.end]).toEqual([24 / 60, 34 / 60]);
});

test("key times read back to the millisecond", async () => {
  const { id } = (await runAiTool("add_shape", { shape: "rect", start: 0, end: 2, lane: 1 })) as { id: string };
  const out = (await runAiTool("set_overlay_keyframes", { id, keys: [{ t: 0.516667, scale: 1 }, { t: 0.666667, scale: 2 }] })) as { keys: { t: number }[] };
  expect(out.keys.map((k) => k.t)).toEqual([0.517, 0.667]);
  const ctx = buildAiContext() as unknown as { overlays: { keyframes?: { t: number }[] }[] };
  expect(ctx.overlays[0].keyframes?.map((k) => k.t)).toEqual([0.517, 0.667]);
});

test("an undo inside a chat turn steps back one edit at a time, never into the turn before", async () => {
  const s = () => useEditor.getState();
  const { id } = (await runAiTool("add_shape", { shape: "rect", start: 0, end: 1, lane: 1, fill: "#111111" })) as { id: string };
  // The turn before: one committed step.
  s().beginHistoryBatch();
  await runAiTool("update_overlay", { id, fill: "#222222" });
  s().endHistoryBatch();
  // This turn tries two edits and takes each back.
  s().beginHistoryBatch();
  await runAiTool("update_overlay", { id, fill: "#333333" });
  await runAiTool("undo", {});
  const fill = () => (s().overlays.find((o) => o.id === id) as { fill?: string }).fill;
  expect(fill()).toBe("#222222");
  await runAiTool("update_overlay", { id, fill: "#444444" });
  await runAiTool("undo", {});
  expect(fill()).toBe("#222222");
  s().endHistoryBatch();
});

test("a time written to the microsecond or the millisecond lands on its frame", async () => {
  // 1.016667 is 61/60 to six places, but sits a hair past frame 61, so that
  // frame would still show what came before.
  const { id } = (await runAiTool("add_shape", { shape: "rect", start: 1.016667, end: 1.233333, lane: 1 })) as { id: string };
  const o = () => useEditor.getState().overlays.find((x) => x.id === id)!;
  expect(o().start).toBe(61 / 60);
  expect(o().end).toBe(74 / 60);
  // So does one written to the millisecond, the way the tools report it;
  // a time more than half a millisecond off every frame stays as written.
  await runAiTool("update_overlay", { id, start: 1.017, end: 1.233 });
  expect([o().start, o().end]).toEqual([61 / 60, 74 / 60]);
  await runAiTool("update_overlay", { id, start: 1.0177, end: 1.2342 });
  expect([o().start, o().end]).toEqual([1.0177, 1.2342]);
  const { id: title } = (await runAiTool("add_title", { text: "GO", start: 2, end: 3, lane: 2 })) as { id: string };
  await runAiTool("set_overlay_animation", { id: title, font_cycle: [{ font: "impact", hold: 0.216667 }, { font: "serif" }], font_cycle_at: 0.083333, font_cycle_seconds: 0.5 });
  const fonts = (useEditor.getState().overlays.find((x) => x.id === title) as { anim?: { fonts?: { at: number; faces: { hold?: number }[] } } }).anim?.fonts;
  expect(fonts?.at).toBe(5 / 60);
  expect(fonts?.faces[0].hold).toBe(13 / 60);
});
