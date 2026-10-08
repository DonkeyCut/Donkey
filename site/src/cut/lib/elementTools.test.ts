import { beforeEach, describe, expect, test } from "bun:test";
import { DOODLE_INKS_MAX } from "@donkeycut/effects-kit";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles, isShapeOverlay, isTextOverlay } from "./types";

/** Tight display tracking and graffiti doodles through the assistant's tools. */

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

describe("title tracking", () => {
  beforeEach(reset);

  test("display type keeps a tight negative tracking", async () => {
    await runAiTool("add_text_sequence", { lines: [{ text: "STAY", start: 0, end: 2 }] });
    const id = useEditor.getState().overlays.filter(isTextOverlay)[0].id;
    await runAiTool("update_overlay", { id, letter_spacing: -0.1 });
    expect(useEditor.getState().overlays.filter(isTextOverlay)[0].letterSpacing).toBeCloseTo(-0.1, 6);
  });
});

describe("doodle shapes", () => {
  beforeEach(reset);

  test("a doodle arrives in the graffiti set and takes its own inks", async () => {
    const made = (await runAiTool("add_shape", { shape: "doodle", start: 0, end: 3 })) as { id: string };
    const fresh = useEditor.getState().overlays.filter(isShapeOverlay)[0];
    expect(fresh.shape).toBe("doodle");
    expect((fresh.inks ?? []).length).toBeGreaterThan(0);
    await runAiTool("update_overlay", { id: made.id, inks: ["#ff0000", 4, "#00ff00", "", "#0000ff", "#111", "#222", "#333"] });
    const inked = useEditor.getState().overlays.filter(isShapeOverlay)[0];
    expect(inked.inks).toEqual(["#ff0000", "#00ff00", "#0000ff", "#111", "#222"].slice(0, DOODLE_INKS_MAX));
    await runAiTool("update_overlay", { id: made.id, inks: [] });
    expect(useEditor.getState().overlays.filter(isShapeOverlay)[0].inks).toBeUndefined();
  });
});

describe("shape patterns", () => {
  beforeEach(reset);

  test("the pattern fields the catalog teaches set and clear stripes", async () => {
    const made = (await runAiTool("add_shape", { shape: "rect", start: 0, end: 3, pattern: "stripes", pattern_gap: 4 })) as { id: string };
    expect(useEditor.getState().overlays.filter(isShapeOverlay)[0].pattern?.gap).toBe(4);
    await runAiTool("update_overlay", { id: made.id, pattern_width: 6 });
    expect(useEditor.getState().overlays.filter(isShapeOverlay)[0].pattern?.width).toBe(6);
    await runAiTool("update_overlay", { id: made.id, pattern: "none" });
    expect(useEditor.getState().overlays.filter(isShapeOverlay)[0].pattern).toBeUndefined();
  });
});
