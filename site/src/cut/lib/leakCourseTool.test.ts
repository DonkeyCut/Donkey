import { beforeEach, describe, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles } from "./types";

/** A light leak's course through add_effect. */

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

describe("add_effect light leak course", () => {
  beforeEach(reset);

  test("a light leak takes the burn course and refuses an unknown one", async () => {
    const { id } = (await runAiTool("add_effect", { effect: "lightleak", start: 1, end: 1.5, leak: "burn" })) as { id: string };
    expect(useEditor.getState().overlays.find((o) => o.id === id)).toMatchObject({ effect: "lightleak", leak: "burn" });
    let message = "";
    try {
      await runAiTool("add_effect", { effect: "lightleak", leak: "flare" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("leak is one of");
  });
});
