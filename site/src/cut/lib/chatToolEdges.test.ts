import { beforeEach, describe, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles, type EffectOverlay, type MediaAsset } from "./types";

/** Edges a review of the template run's chat tools turned up: a write that
 * fails must leave nothing half done, one call is one undo step, and a sweep
 * takes only what this chat can see. */

const fx = (id: string): EffectOverlay =>
  ({ id, kind: "effect", effect: "lightleak", amount: 0.5, start: 0, end: 1, x: 0.5, y: 0.5, lane: 0 }) as unknown as EffectOverlay;
const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset =>
  ({ id, fileName: `${id}.mp4`, name: id, type: "video", duration: 5, url: "", ...extra }) as MediaAsset;

beforeEach(() => {
  useEditor.setState({
    projectId: null,
    aspect: "16:9",
    assets: [],
    clips: [],
    audioClips: [],
    overlays: [fx("a"), fx("b")],
    transitions: [],
    subtitles: emptySubtitles(),
    timelines: {},
    notes: { text: "", publishedAt: "", links: [] },
  });
});

const overlay = (id: string) => useEditor.getState().overlays.find((o) => o.id === id) as EffectOverlay;

describe("update_overlay on effects", () => {
  test("a write across several effects undoes in one step", async () => {
    await runAiTool("update_overlay", { ids: ["a", "b"], amount: 1, leak: "char" });
    expect(overlay("a").leak).toBe("char");
    useEditor.getState().undo();
    expect(overlay("a")).toMatchObject({ amount: 0.5 });
    expect(overlay("b")).toMatchObject({ amount: 0.5 });
    expect(overlay("a").leak).toBeUndefined();
    expect(overlay("b").leak).toBeUndefined();
  });

  test("a bad setting is refused before anything is written", async () => {
    await expect(runAiTool("update_overlay", { ids: ["a", "b"], amount: 1, leak: "flare" })).rejects.toThrow();
    expect(overlay("a").amount).toBe(0.5);
    expect(overlay("b").amount).toBe(0.5);
  });
});

describe("delete_asset", () => {
  test("the unused sweep leaves another chat's unplaced media and the project's fonts alone", async () => {
    useEditor.setState({
      overlays: [],
      assets: [
        asset("spare"),
        asset("theirs", { origin: "chat", chatId: "other-thread" } as Partial<MediaAsset>),
        asset("font", { type: "font" } as unknown as Partial<MediaAsset>),
      ],
    });
    const out = (await runAiTool("delete_asset", { unused: true })) as { removed: number; names: string[] };
    expect(out).toMatchObject({ removed: 1, names: ["spare"] });
    expect(useEditor.getState().assets.map((a) => a.id)).toEqual(["theirs", "font"]);
  });

  test("an empty asset_ids list falls back to asset_id, and repeated ids count once", async () => {
    useEditor.setState({ overlays: [], assets: [asset("c"), asset("d")] });
    await runAiTool("delete_asset", { asset_id: "c", asset_ids: [] });
    expect(useEditor.getState().assets.map((a) => a.id)).toEqual(["d"]);
    const out = (await runAiTool("delete_asset", { asset_ids: ["d", "d"] })) as { removed: number };
    expect(out.removed).toBe(1);
  });
});

test("set_project_notes skips a link repeated within the same call", async () => {
  const out = (await runAiTool("set_project_notes", { add_links: ["https://x.test", "https://x.test"] })) as { links: string[] };
  expect(out.links).toEqual(["https://x.test"]);
});

test("set_transition refuses a band on a crossfade before it writes the crossfade", async () => {
  useEditor.setState({ overlays: [], assets: [asset("v")] });
  await runAiTool("add_clip", { asset_id: "v" });
  await runAiTool("add_clip", { asset_id: "v" });
  const first = useEditor.getState().clips[0];
  await expect(runAiTool("set_transition", { clipId: first.id, seconds: 0.4, style: "crossfade", band: 0.3 })).rejects.toThrow();
  expect(useEditor.getState().clips[0].transition ?? 0).toBe(0);
});

describe("rename_item", () => {
  test("names many items in one call and undoes in one step", async () => {
    await runAiTool("rename_item", { names: [{ id: "a", name: "s01a" }, { id: "b", name: "s01b" }] });
    expect(overlay("a").name).toBe("s01a");
    expect(overlay("b").name).toBe("s01b");
    useEditor.getState().undo();
    expect(overlay("a").name).toBeUndefined();
    expect(overlay("b").name).toBeUndefined();
  });

  test("an unknown id is refused before any name is written", async () => {
    await expect(runAiTool("rename_item", { names: [{ id: "a", name: "s01a" }, { id: "zz", name: "s02" }] })).rejects.toThrow();
    expect(overlay("a").name).toBeUndefined();
  });
});

describe("add_title and add_shape lists", () => {
  // A stretch of a template's type in one call: each item lands with its own
  // fields and the result lists the new ids in order.
  test("titles land with their fields, ids in order, and undo in one step", async () => {
    const out = (await runAiTool("add_title", {
      titles: [
        { text: "ONE", start: 0, end: 1, x: 0.3, color: "#ff0000", lane: 1 },
        { text: "TWO", start: 1, end: 2, y: 0.7, size: 120 },
      ],
    })) as { ids: string[]; titles: { id: string; text: string }[] };
    const made = useEditor.getState().overlays.filter((o) => out.ids.includes(o.id)) as unknown as Record<string, unknown>[];
    expect(out.ids).toHaveLength(2);
    expect(out.titles.map((t) => t.text)).toEqual(["ONE", "TWO"]);
    expect(made.find((o) => o.id === out.ids[0])).toMatchObject({ text: "ONE", start: 0, end: 1, x: 0.3, color: "#ff0000", lane: 1 });
    expect(made.find((o) => o.id === out.ids[1])).toMatchObject({ text: "TWO", start: 1, end: 2, y: 0.7, size: 120 });
    useEditor.getState().undo();
    expect(useEditor.getState().overlays.map((o) => o.id)).toEqual(["a", "b"]);
  });

  // One bad item refuses the whole call, naming the item.
  test("a bad title is refused before any title is written", async () => {
    await expect(runAiTool("add_title", { titles: [{ text: "ONE" }, { text: "TWO", font: "no-such-face" }] })).rejects.toThrow(/titles\[1\]/);
    await expect(runAiTool("add_title", { titles: [{ text: "ONE" }, { text: " " }] })).rejects.toThrow(/titles\[1\]/);
    expect(useEditor.getState().overlays.map((o) => o.id)).toEqual(["a", "b"]);
  });

  // A one-title call keeps the result it always had.
  test("a single title keeps its result shape", async () => {
    const out = (await runAiTool("add_title", { text: "SOLO", start: 0, end: 1 })) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["end", "id", "start", "text"]);
  });

  test("shapes land with their fields, ids in order, and undo in one step", async () => {
    const out = (await runAiTool("add_shape", {
      shapes: [
        { shape: "rect", start: 0, end: 1, w: 0.5, fill: "#00ff00", lane: 2 },
        { shape: "ellipse", start: 1, end: 2, x: 0.2, h: 0.3 },
      ],
    })) as { ids: string[]; shapes: { id: string; shape: string }[] };
    const made = useEditor.getState().overlays as unknown as Record<string, unknown>[];
    expect(out.shapes.map((s) => s.shape)).toEqual(["rect", "ellipse"]);
    expect(made.find((o) => o.id === out.ids[0])).toMatchObject({ shape: "rect", start: 0, end: 1, w: 0.5, fill: "#00ff00", lane: 2 });
    expect(made.find((o) => o.id === out.ids[1])).toMatchObject({ shape: "ellipse", start: 1, end: 2, x: 0.2, h: 0.3 });
    useEditor.getState().undo();
    expect(useEditor.getState().overlays.map((o) => o.id)).toEqual(["a", "b"]);
  });

  test("a bad shape is refused before any shape is written", async () => {
    await expect(runAiTool("add_shape", { shapes: [{ shape: "rect" }, { shape: "blob" }] })).rejects.toThrow(/shapes\[1\]/);
    await expect(runAiTool("add_shape", { shapes: [{ shape: "rect" }, { shape: "rect", pattern: "zigzag" }] })).rejects.toThrow(/shapes\[1\]/);
    expect(useEditor.getState().overlays.map((o) => o.id)).toEqual(["a", "b"]);
  });
});
