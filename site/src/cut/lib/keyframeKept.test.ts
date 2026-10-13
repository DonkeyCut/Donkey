import { beforeEach, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import type { TextOverlay } from "./types";

/** A merge that leaves keys the call never named says so: the chat sent the
 * same three keys twenty times, each time getting back a fourth it meant to
 * drop, because nothing in the result told it the old key had stayed. */

const t1: TextOverlay = { id: "t1", text: "2025", start: 0, end: 2, x: 0.5, y: 0.5, size: 88, font: "sf", color: "#fff" } as TextOverlay;

beforeEach(async () => {
  useEditor.setState({ overlays: [t1] });
  await runAiTool("set_overlay_keyframes", { id: "t1", keys: [{ t: 0, y: 0.49 }, { t: 1, y: 0.53 }, { t: 1.5, y: 0.49 }] });
});

test("keys the call left in place come back named, with the way to drop them", async () => {
  const out = (await runAiTool("set_overlay_keyframes", { id: "t1", keys: [{ t: 0, y: 0.56 }, { t: 1.5, y: 0.56 }] })) as {
    kept?: number[];
    note?: string;
  };
  expect(out.kept).toEqual([1]);
  expect(out.note).toContain("empty keys list");
});

test("a call that names every key, or clears the track, reports nothing kept", async () => {
  const all = (await runAiTool("set_overlay_keyframes", { id: "t1", keys: [{ t: 0, y: 0.56 }, { t: 1, y: 0.56 }, { t: 1.5, y: 0.56 }] })) as { kept?: number[] };
  expect(all.kept).toBeUndefined();
  const cleared = (await runAiTool("set_overlay_keyframes", { id: "t1", keys: [] })) as { kept?: number[]; keys: unknown[] };
  expect(cleared.kept).toBeUndefined();
  expect(cleared.keys).toHaveLength(0);
});
