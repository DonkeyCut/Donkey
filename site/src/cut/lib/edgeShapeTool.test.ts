import { beforeEach, describe, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles, isTextOverlay } from "./types";

/**
 * A letter-by-letter drop read off a reference through set_overlay_animation:
 * its order, its reach, and a ramp long enough for a whole title.
 */

const reset = () =>
  useEditor.setState({
    projectId: "p1",
    aspect: "16:9",
    assets: [],
    clips: [],
    overlays: [],
    subtitles: emptySubtitles(),
    background: "#000000",
  });

const title = async () => {
  await runAiTool("add_text_sequence", {
    look: "serif-mood",
    lines: [{ text: "YOUR LOCATION", start: 0, end: 6 }],
  });
  return useEditor.getState().overlays.filter(isTextOverlay)[0];
};
const edgeOf = (id: string) => useEditor.getState().overlays.find((o) => o.id === id)!.anim?.in;

describe("set_overlay_animation letter order and reach", () => {
  beforeEach(reset);

  test("a sequence of letters lands as glyph indices, spaces skipped", async () => {
    const t = await title();
    await runAiTool("set_overlay_animation", { id: t.id, in_style: "drop", in_seconds: 2.6, in_sequence: [5, 4, 0] });
    // L is letter 4 but glyph 5: the space before it takes a turn.
    expect(edgeOf(t.id)?.order).toEqual([6, 5, 0]);
    expect(edgeOf(t.id)?.seconds).toBe(2.6);
    await runAiTool("set_overlay_animation", { id: t.id, in_sequence: [] });
    expect(edgeOf(t.id)?.order).toBeUndefined();
  });

  test("shuffle and reading set the order, a distance the reach, 0 hands it back", async () => {
    const t = await title();
    await runAiTool("set_overlay_animation", { id: t.id, in_style: "drop", in_order: "shuffle", in_distance: 600 });
    expect(edgeOf(t.id)).toMatchObject({ order: "shuffle", distance: 600 });
    await runAiTool("set_overlay_animation", { id: t.id, in_order: "reading", in_distance: 0 });
    expect(edgeOf(t.id)?.order).toBeUndefined();
    expect(edgeOf(t.id)?.distance).toBeUndefined();
  });

  test("a sequence that names no letter is refused", async () => {
    const t = await title();
    await runAiTool("set_overlay_animation", { id: t.id, in_style: "drop" });
    await expect(runAiTool("set_overlay_animation", { id: t.id, in_sequence: [40] })).rejects.toThrow("names no letter");
  });
});

describe("set_overlay_animation ease and fade", () => {
  beforeEach(reset);

  test("a named ease and fade off ride the slot; style and true hand them back", async () => {
    const t = await title();
    await runAiTool("set_overlay_animation", { id: t.id, in_style: "drop", in_ease: "linear", in_fade: false });
    expect(edgeOf(t.id)).toMatchObject({ ease: "linear", fade: false });
    await runAiTool("set_overlay_animation", { id: t.id, in_ease: "style", in_fade: true });
    expect(edgeOf(t.id)?.ease).toBeUndefined();
    expect(edgeOf(t.id)?.fade).toBeUndefined();
  });
});
