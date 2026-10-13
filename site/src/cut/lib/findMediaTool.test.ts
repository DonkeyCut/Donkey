import { beforeEach, describe, expect, test } from "bun:test";
import { buildAiContext } from "./aiContext";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles, type MediaAsset } from "./types";
import { AI_PANEL_TOOLS } from "../components/AiPanel.tools";

/** Media past the context snapshot's cap is found by name through
 * find_media, so a long project's last imports still have ids to act on. */

const image = (i: number): MediaAsset => ({
  id: `img${i}`,
  fileName: `gref_s${String(i).padStart(2, "0")}.jpg`,
  name: `gref_s${String(i).padStart(2, "0")}.jpg`,
  type: "image",
  duration: 0,
  url: "",
});
const clipFile = (i: number): MediaAsset => ({ id: `v${i}`, fileName: `clip${i}.mp4`, name: `clip${i}`, type: "video", duration: 5, url: "" });

beforeEach(() => {
  useEditor.setState({
    projectId: "p1",
    aspect: "16:9",
    assets: [
      ...Array.from({ length: 70 }, (_, i) => clipFile(i)),
      ...Array.from({ length: 69 }, (_, i) => image(i + 1)),
      { ...image(99), id: "other", name: "gref_private.jpg", origin: "chat", chatId: "someone-else" },
    ],
    clips: [],
    audioClips: [],
    overlays: [],
    subtitles: emptySubtitles(),
    background: "#000000",
  });
});

type Found = { total: number; assets: { id: string; name: string; type: string }[]; next?: number };

describe("find_media", () => {
  test("the snapshot trims a long media list, and says so", () => {
    const ctx = buildAiContext({ chatId: null });
    expect(ctx.mediaTruncated).toBe(true);
    expect(ctx.media.some((m) => m.name === "gref_s60.jpg")).toBe(false);
  });

  test("finds media past the cap by name, case-insensitively", async () => {
    const out = (await runAiTool("find_media", { query: "GREF_S6" })) as Found;
    expect(out.assets.map((a) => a.name)).toEqual(Array.from({ length: 10 }, (_, i) => `gref_s6${i}.jpg`));
    expect(out.assets[0]).toMatchObject({ id: "img60", type: "image" });
  });

  test("filters by kind and pages through a long answer", async () => {
    const first = (await runAiTool("find_media", { type: "image", limit: 50 })) as Found;
    expect(first.total).toBe(69);
    expect(first.assets).toHaveLength(50);
    expect(first.next).toBe(50);
    const rest = (await runAiTool("find_media", { type: "image", limit: 50, offset: first.next })) as Found;
    expect(rest.assets).toHaveLength(19);
    expect(rest.next).toBeUndefined();
  });

  test("another chat's unplaced media stays hidden, as it does in the snapshot", async () => {
    const out = (await runAiTool("find_media", { query: "private" })) as Found;
    expect(out.total).toBe(0);
  });

  test("the chat is offered the tool", () => {
    expect(AI_PANEL_TOOLS.some((t) => t.name === "find_media")).toBe(true);
  });
});
