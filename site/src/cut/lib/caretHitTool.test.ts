import { beforeEach, describe, expect, test } from "bun:test";
import { OVERLAY_HIT_STYLE_IDS } from "@donkeycut/effects-kit";
import { OVERLAY_ANIMATION_TOOLS } from "@/cut/components/AnimationTiles.tools";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles, isTextOverlay } from "./types";

/**
 * The call-to-action pieces through set_overlay_animation: a caret on a
 * typewriter entrance, and a press at a moment inside the element.
 */

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

const overlays = () => useEditor.getState().overlays;
const aTitle = async () => {
  await runAiTool("add_text_sequence", {
    look: "serif-mood",
    lines: [{ text: "LINK", start: 0, end: 4 }],
  });
  return overlays().filter(isTextOverlay)[0];
};
const failure = async (args: Record<string, unknown>) => {
  try {
    await runAiTool("set_overlay_animation", args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
};

describe("set_overlay_animation caret and hit", () => {
  beforeEach(reset);

  test("the schema lists every hit the catalog has", () => {
    const tool = OVERLAY_ANIMATION_TOOLS.find((t) => t.name === "set_overlay_animation")!;
    const props = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.hit_style.enum).toEqual([...OVERLAY_HIT_STYLE_IDS, "none"]);
    for (const key of ["caret", "caret_blink", "caret_blinks", "caret_hide", "caret_color", "hit_at", "hit_seconds", "hit_darken"])
      expect(props[key]).toBeDefined();
    expect(tool.description).toContain("press");
  });

  test("a caret rides the typewriter entrance and its settings land on it", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", { id: o.id, in_style: "typewriter", in_seconds: 1, caret: true, caret_blinks: 3, caret_hide: true });
    expect(overlays()[0].anim?.in?.caret).toEqual({ blink: true, blinks: 3, hide: true });
    // Re-picking a typing entrance keeps the bar; clearing it takes it off.
    await runAiTool("set_overlay_animation", { id: o.id, in_style: "typewriter" });
    expect(overlays()[0].anim?.in?.caret?.blinks).toBe(3);
    await runAiTool("set_overlay_animation", { id: o.id, caret: false });
    expect(overlays()[0].anim?.in?.caret).toBeUndefined();
  });

  test("a caret colour has to be a hex colour", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", { id: o.id, in_style: "typewriter", caret: true, caret_color: "#f50" });
    expect(overlays()[0].anim?.in?.caret?.color).toBe("#ff5500");
    expect(await failure({ id: o.id, caret_color: "accent" })).toContain("hex colour");
    expect(overlays()[0].anim?.in?.caret?.color).toBe("#ff5500");
  });

  test("a caret without a typing entrance is refused", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", { id: o.id, in_style: "fade" });
    expect(await failure({ id: o.id, caret: true })).toContain("typewriter");
  });

  test("a press lands at its moment, held inside the element, darkening by default", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", { id: o.id, hit_style: "press", hit_at: 2.5 });
    expect(overlays()[0].anim?.hit).toEqual({ style: "press", at: 2.5, seconds: 0.3, darken: true });
    await runAiTool("set_overlay_animation", { id: o.id, hit_at: 10, hit_darken: false });
    expect(overlays()[0].anim?.hit).toEqual({ style: "press", at: 3.7, seconds: 0.3, darken: false });
    expect(await failure({ id: o.id, hit_style: "smash" })).toContain("Unknown hit style");
    await runAiTool("set_overlay_animation", { id: o.id, hit_style: "none" });
    expect(overlays()[0].anim?.hit).toBeUndefined();
  });
});
