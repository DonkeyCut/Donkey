import { beforeEach, describe, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles } from "./types";
import { INSPECTOR_TOOLS } from "../components/Inspector.tools";

/** An effect element's own settings changed in place through update_overlay,
 * so its id, lane and timing survive the edit. */

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

const overlay = (id: string) => useEditor.getState().overlays.find((o) => o.id === id);

async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
}

describe("update_overlay on an effect", () => {
  beforeEach(reset);

  test("a light leak's amount and course change in place", async () => {
    const { id } = (await runAiTool("add_effect", { effect: "lightleak", start: 1, end: 1.5, leak: "burn", amount: 0.8 })) as { id: string };
    await runAiTool("update_overlay", { id, amount: 1, leak: "char" });
    expect(overlay(id)).toMatchObject({ effect: "lightleak", leak: "char", amount: 1, start: 1, end: 1.5 });
    await runAiTool("update_overlay", { id, leak: "drift" });
    expect((overlay(id) as { leak?: string }).leak).toBeUndefined();
    expect(await errorOf(() => runAiTool("update_overlay", { id, leak: "flare" }))).toContain("leak is one of");
  });

  test("a flash's tone, strobe and rhythm, and a glitch's kind, change in place", async () => {
    const { id: flash } = (await runAiTool("add_effect", { effect: "flash", start: 2, end: 3 })) as { id: string };
    await runAiTool("update_overlay", { id: flash, tone: "black", rate: 6, rhythm: "flicker" });
    expect(overlay(flash)).toMatchObject({ tone: "black", rate: 6, rhythm: "flicker" });
    const { id: glitch } = (await runAiTool("add_effect", { effect: "glitch", start: 0, end: 1 })) as { id: string };
    await runAiTool("update_overlay", { id: glitch, glitch: "rgb" });
    expect(overlay(glitch)).toMatchObject({ glitch: "rgb" });
  });

  test("a negative strobes at a rate, on the timeline and on a clip", async () => {
    const { id } = (await runAiTool("add_effect", { effect: "negative", start: 4.9, end: 5.43, rate: 15 })) as { id: string };
    expect(overlay(id)).toMatchObject({ effect: "negative", rate: 15 });
    await runAiTool("update_overlay", { id, rate: 0 });
    expect((overlay(id) as { rate?: number }).rate).toBeUndefined();
    useEditor.setState({ clips: [{ id: "c1", assetId: "a", start: 0, in: 0, out: 2, speed: 1 } as never] });
    await runAiTool("set_clip_effects", { clipId: "c1", effects: [{ effect: "negative", rate: 15 }] });
    expect(useEditor.getState().clips[0].effects).toEqual([{ effect: "negative", rate: 15 }]);
  });

  test("a cutout clip's flash fades from its tone, the silhouette it lands as", async () => {
    useEditor.setState({ clips: [{ id: "c1", assetId: "a", start: 0, in: 0, out: 2, speed: 1 } as never] });
    await runAiTool("set_clip_effects", { clipId: "c1", effects: [{ effect: "flash", amount: 1, fade: "from" }] });
    expect(useEditor.getState().clips[0].effects).toEqual([{ effect: "flash", amount: 1, fade: "from" }]);
    expect(await errorOf(() => runAiTool("set_clip_effects", { clipId: "c1", effects: [{ effect: "flash", fade: "out" }] }))).toContain("fade is one of");
  });

  test("a flash's fade comes off again with none, back to the pop", async () => {
    const { id } = (await runAiTool("add_effect", { effect: "flash", start: 2, end: 3, fade: "to" })) as { id: string };
    expect(overlay(id)).toMatchObject({ fade: "to" });
    await runAiTool("update_overlay", { id, fade: "none" });
    expect((overlay(id) as { fade?: string }).fade).toBeUndefined();
    const props = INSPECTOR_TOOLS.find((t) => t.name === "update_overlay")!.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.fade.enum).toContain("none");
  });

  test("a flash's fade runs along the ease it is given, and linear is the even ramp again", async () => {
    const { id } = (await runAiTool("add_effect", { effect: "flash", tone: "black", start: 2, end: 2.5, fade: "to", fade_ease: "sine.out", amount: 0.94 })) as {
      id: string;
    };
    expect(overlay(id)).toMatchObject({ fade: "to", fadeEase: "sine.out", amount: 0.94 });
    await runAiTool("update_overlay", { id, fade_ease: "linear" });
    expect((overlay(id) as { fadeEase?: string }).fadeEase).toBeUndefined();
    expect(await errorOf(() => runAiTool("update_overlay", { id, fade_ease: "bounce" }))).toContain("fade_ease is one of");
    const props = INSPECTOR_TOOLS.find((t) => t.name === "update_overlay")!.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.fade_ease.enum).toContain("power2.out");
    useEditor.setState({ clips: [{ id: "c1", assetId: "a", start: 0, in: 0, out: 2, speed: 1 } as never] });
    await runAiTool("set_clip_effects", { clipId: "c1", effects: [{ effect: "flash", fade: "to", fade_ease: "power2.out" }] });
    expect(useEditor.getState().clips[0].effects).toEqual([{ effect: "flash", fade: "to", fadeEase: "power2.out" }]);
  });

  test("a setting the effect doesn't take is skipped, like any field a kind lacks", async () => {
    const { id } = (await runAiTool("add_effect", { effect: "flash", start: 2, end: 3 })) as { id: string };
    await runAiTool("update_overlay", { id, leak: "burn" });
    expect((overlay(id) as { leak?: string }).leak).toBeUndefined();
  });

  test("the tool's schema offers the effect settings", () => {
    const props = INSPECTOR_TOOLS.find((t) => t.name === "update_overlay")!.inputSchema.properties as Record<string, unknown>;
    for (const k of ["amount", "leak", "glitch", "tone", "rate", "rhythm", "fade"]) expect(Object.keys(props)).toContain(k);
  });
});
