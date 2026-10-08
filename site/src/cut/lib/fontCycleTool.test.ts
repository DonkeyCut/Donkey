import { beforeEach, describe, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles, isTextOverlay } from "./types";

/** A title's font cycle and its heavy weights through the assistant's tools. */

const reset = () =>
  useEditor.setState({
    projectId: "p1",
    aspect: "9:16",
    assets: [],
    clips: [],
    overlays: [],
    subtitles: emptySubtitles(),
    background: "#000000",
  });

const titles = () => useEditor.getState().overlays.filter(isTextOverlay);
const aTitle = async () => {
  await runAiTool("add_text_sequence", {
    look: "serif-mood",
    lines: [{ text: "STAY TUNED", start: 0, end: 4 }],
  });
  return titles()[0];
};
const failure = async (args: Record<string, unknown>) => {
  try {
    await runAiTool("set_overlay_animation", args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
};

describe("set_overlay_animation font cycle", () => {
  beforeEach(reset);

  test("a new cycle runs the title's length at the default rate", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", {
      id: o.id,
      font_cycle: [{ font: "impact", weight: 900, scale: 1.4 }, { font: "mono", tracking: 0.1 }],
    });
    expect(titles()[0].anim?.fonts).toEqual({
      faces: [{ font: "impact", weight: 900, scale: 1.4 }, { font: "mono", tracking: 0.1 }],
      at: 0,
      seconds: 4,
      rate: 15,
    });
  });

  test("timing holds inside the title and the rate in range", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", {
      id: o.id,
      font_cycle: [{ font: "serif" }],
      font_cycle_at: 3,
      font_cycle_seconds: 9,
      font_cycle_rate: 400,
    });
    expect(titles()[0].anim?.fonts).toMatchObject({ at: 3, seconds: 1, rate: 30 });
    // Timing alone retimes the cycle the title already has.
    await runAiTool("set_overlay_animation", { id: o.id, font_cycle_at: 1 });
    expect(titles()[0].anim?.fonts).toMatchObject({ at: 1, faces: [{ font: "serif" }] });
  });

  test("an empty list removes the cycle", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", { id: o.id, font_cycle: [{ font: "serif" }] });
    await runAiTool("set_overlay_animation", { id: o.id, font_cycle: [] });
    expect(titles()[0].anim?.fonts).toBeUndefined();
  });

  test("an unknown font or weight is refused", async () => {
    const o = await aTitle();
    expect(await failure({ id: o.id, font_cycle: [{ font: "no-such-face" }] })).toContain("Unknown font id");
    expect(await failure({ id: o.id, font_cycle: [{ font: "serif", weight: 450 }] })).toContain("weight");
  });

  test("a title takes the heavy weights", async () => {
    const o = await aTitle();
    await runAiTool("update_overlay", { id: o.id, weight: 900 });
    expect(titles()[0].weight).toBe(900);
  });
});
