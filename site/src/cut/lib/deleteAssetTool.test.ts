import { beforeEach, describe, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles, type MediaAsset } from "./types";
import { SIDE_PANEL_TOOLS } from "../components/SidePanel.tools";

/** Clearing a project's leftover media in one call: the unused sweep takes
 * everything no timeline uses, open or parked, and a list takes several ids
 * at once — where one id per call meant a call per file and ids the chat
 * could not tell apart from placed media. */

const asset = (id: string): MediaAsset => ({ id, fileName: `${id}.mp4`, name: id, type: "video", duration: 5, url: "" });

beforeEach(async () => {
  useEditor.setState({
    projectId: null,
    aspect: "16:9",
    assets: ["placed", "parked", "spare1", "spare2", "spare3"].map(asset),
    clips: [],
    audioClips: [],
    overlays: [],
    transitions: [],
    subtitles: emptySubtitles(),
    background: "#000000",
    timelines: {},
  });
  await runAiTool("add_clip", { asset_id: "placed" });
  // A clip on the closed Second timeline still uses its asset.
  const s = useEditor.getState();
  useEditor.setState({
    timelines: { second: { clips: [{ ...s.clips[0], id: "c2", assetId: "parked" }], audioClips: [], overlays: [] } as never },
  });
});

const ids = () => useEditor.getState().assets.map((a) => a.id);

describe("delete_asset", () => {
  test("unused:true removes every asset no timeline uses, open or parked", async () => {
    const out = (await runAiTool("delete_asset", { unused: true })) as { removed: number; clipsRemoved: number };
    expect(out).toMatchObject({ removed: 3, clipsRemoved: 0 });
    expect(ids()).toEqual(["placed", "parked"]);
  });

  test("the sweep leaves another chat's unused media and says how many it left", async () => {
    useEditor.setState({ assets: [...useEditor.getState().assets, { ...asset("theirs"), origin: "chat", chatId: "other-thread" }] });
    const out = (await runAiTool("delete_asset", { unused: true })) as { removed: number; heldByOtherChats?: number; note?: string };
    expect(out.removed).toBe(3);
    expect(ids()).toContain("theirs");
    expect(out.heldByOtherChats).toBe(1);
    expect(out.note).toMatch(/another chat/i);
  });

  test("asset_ids removes several at once and counts the clips that went with them", async () => {
    const out = (await runAiTool("delete_asset", { asset_ids: ["spare1", "placed"] })) as { removed: number; clipsRemoved: number };
    expect(out).toMatchObject({ removed: 2, clipsRemoved: 1 });
    expect(ids()).toEqual(["parked", "spare2", "spare3"]);
    expect(useEditor.getState().clips).toHaveLength(0);
  });

  test("one asset_id still works as before", async () => {
    const out = (await runAiTool("delete_asset", { asset_id: "spare2" })) as { removed: string };
    expect(out.removed).toBe("spare2");
    expect(ids()).not.toContain("spare2");
  });

  test("the schema offers the list and the sweep", () => {
    const def = SIDE_PANEL_TOOLS.find((t) => t.name === "delete_asset")!;
    const props = def.inputSchema.properties as Record<string, unknown>;
    for (const k of ["asset_id", "asset_ids", "unused"]) expect(Object.keys(props)).toContain(k);
  });
});
