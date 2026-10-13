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
