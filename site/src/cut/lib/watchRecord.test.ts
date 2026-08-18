import { beforeEach, describe, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { buildAiContext } from "./aiContext";
import { useEditor } from "./store";
import type { MediaAsset } from "./types";

/**
 * The written record of a source: what note_source stores on the asset, and
 * how the editor snapshot hands it back. It is what makes a source longer
 * than one look usable — the contact sheets are gone by the next turn, this
 * is not.
 */

const source: MediaAsset = {
  id: "a1",
  fileName: "talk.mp4",
  name: "talk.mp4",
  type: "video",
  duration: 3600,
  url: "",
};

const noteOf = (id: string) => useEditor.getState().assets.find((a) => a.id === id)?.watch?.notes;

describe("note_source", () => {
  beforeEach(() => {
    useEditor.setState({ projectId: "p1", assets: [{ ...source }], clips: [], overlays: [] });
  });

  test("writes what was seen onto the source, in source seconds", async () => {
    await runAiTool("note_source", {
      asset_id: "a1",
      notes: [
        { from: 0, to: 300, text: 'cold open on a whiteboard; card reads "Yo, I got a Mil in $ idea"' },
        { from: 300, to: 600, text: "the diagram builds, one arrow per beat" },
      ],
    });
    expect(noteOf("a1")).toEqual([
      { from: 0, to: 300, text: 'cold open on a whiteboard; card reads "Yo, I got a Mil in $ idea"' },
      { from: 300, to: 600, text: "the diagram builds, one arrow per beat" },
    ]);
  });

  test("reports what is still undescribed", async () => {
    const out = (await runAiTool("note_source", {
      asset_id: "a1",
      notes: [{ from: 0, to: 600, text: "the setup" }],
    })) as { unnoted: { from: number; to: number }[] };
    expect(out.unnoted).toEqual([{ from: 600, to: 3600 }]);
  });

  test("a close read supersedes the coarse pass over the same ground", async () => {
    await runAiTool("note_source", {
      asset_id: "a1",
      notes: [{ from: 0, to: 60, text: "titles over b-roll" }],
    });
    await runAiTool("note_source", {
      asset_id: "a1",
      notes: [
        { from: 0, to: 30, text: 'card: "Right?"' },
        { from: 30, to: 60, text: 'card: "Literally"' },
      ],
    });
    expect(noteOf("a1")).toEqual([
      { from: 0, to: 30, text: 'card: "Right?"' },
      { from: 30, to: 60, text: 'card: "Literally"' },
    ]);
  });

  test("a note with no text is refused", async () => {
    let message = "";
    try {
      await runAiTool("note_source", { asset_id: "a1", notes: [{ from: 0, to: 10, text: "  " }] });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("notes");
    expect(noteOf("a1")).toBeUndefined();
  });
});

describe("the snapshot carries the record", () => {
  beforeEach(() => {
    useEditor.setState({ projectId: "p1", assets: [{ ...source }], clips: [], overlays: [] });
  });

  test("notes ride the per-message snapshot while they are small", async () => {
    await runAiTool("note_source", {
      asset_id: "a1",
      notes: [{ from: 0, to: 600, text: "the setup" }],
    });
    const ctx = buildAiContext() as { media: { observed?: { text?: string }[] }[] };
    expect(ctx.media[0].observed).toEqual([{ from: 0, to: 600, text: "the setup" }]);
  });

  test("a long record keeps every span readable and points at get_state", async () => {
    await runAiTool("note_source", {
      asset_id: "a1",
      notes: Array.from({ length: 12 }, (_, i) => ({
        from: i * 300,
        to: (i + 1) * 300,
        text: `segment ${i}: `.padEnd(400, "x"),
      })),
    });
    const snapshot = buildAiContext() as {
      media: { observed?: { text?: string }[]; observedText?: string }[];
    };
    expect(snapshot.media[0].observedText).toBe("shortened here, whole in get_state");
    expect(snapshot.media[0].observed).toHaveLength(12);
    for (const n of snapshot.media[0].observed ?? []) {
      expect(n.text?.length).toBeLessThan(400);
      expect(n.text).toContain("segment");
    }
    const full = buildAiContext({ fullCues: true }) as { media: { observed?: { text?: string }[] }[] };
    expect(full.media[0].observed?.[0].text).toContain("segment 0");
  });
});
