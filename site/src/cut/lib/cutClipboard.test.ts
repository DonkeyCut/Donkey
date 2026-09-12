import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { clipboardHtml, pasteCutPayload, payloadAssets, payloadFromHtml, type CutClipboardPayload } from "./cutClipboard";
import { richDoc } from "./fixtures/richDoc";
import { EMPTY_LIBRARY } from "./assetRef";
import { setPlayhead } from "./playhead";
import { setHostDocStore } from "./projectReference";
import { storedAssets, useEditor, type TimelineClipboardItem } from "./store";
import { emptySubtitles, isStickerOverlay, isTextOverlay, type MediaAsset, type ProjectDoc, type VideoClip } from "./types";

/**
 * ⌘C in one project, ⌘V in another. The copy leaves the tab whole — the
 * items and the media they play — so the paste in the other project brings
 * the media across once, remembers where it came from, and lands the items
 * the way a paste made in that project lands.
 */

const rich = richDoc();
const docs = new Map<string, ProjectDoc>([["rich", rich]]);
const copies: string[] = [];
setHostDocStore({
  readDoc: async (id) => docs.get(id) ?? null,
  copyMedia: async (_src, file) => {
    copies.push(file);
    return `copy-${file}`;
  },
});
afterAll(() => setHostDocStore(null));

const richAssets: MediaAsset[] = (rich.assets ?? []).map((a) => ({ ...a, url: "" }));
const itemsOf = (ids: string[]): TimelineClipboardItem[] =>
  ids.map((id) => {
    const clip = rich.clips?.find((c) => c.id === id);
    if (clip) return { kind: "clip", item: clip };
    const audio = rich.audioClips?.find((c) => c.id === id);
    if (audio) return { kind: "audio", item: audio };
    const overlay = rich.overlays?.find((o) => o.id === id);
    if (overlay) return { kind: "overlay", item: overlay };
    const cue = rich.subtitles?.cues.find((c) => c.id === id);
    if (cue) return { kind: "cue", item: cue };
    throw new Error(`no item ${id}`);
  });
const payloadOf = (ids: string[], projectId = "rich"): CutClipboardPayload => {
  const items = itemsOf(ids);
  return { v: 1, projectId, items, assets: payloadAssets(items, richAssets) };
};

describe("the clipboard flavor", () => {
  test("round-trips through the markup the OS wraps it in", () => {
    const payload = payloadOf(["c0", "t1"]);
    const html = clipboardHtml("@v1 @\"Brand line\"", payload);
    expect(payloadFromHtml(html)).toEqual(payload);
    // Chrome prefixes a charset; Windows wraps the fragment in CF_HTML.
    expect(payloadFromHtml(`<meta charset='utf-8'>${html}`)).toEqual(payload);
    expect(payloadFromHtml(`Version:0.9\r\nStartHTML:000\r\n<html><body><!--StartFragment-->${html}<!--EndFragment--></body></html>`)).toEqual(payload);
    expect(payloadFromHtml("<b>someone else's</b>")).toBeNull();
    expect(payloadFromHtml('<span data-donkeycut="notbase64!!">x</span>')).toBeNull();
    expect(payloadFromHtml(null)).toBeNull();
  });

  test("a copy carries the media its items play: footage, sound, the sticker, the title's font", () => {
    const assets = payloadAssets(itemsOf(["c0", "a0", "s1", "t1", "q0"]), richAssets);
    expect(assets.map((a) => a.id).sort()).toEqual(["f0", "m0", "s0", "v0"]);
    // Stored shape only: nothing runtime rides along.
    expect("url" in assets[0]).toBe(false);
  });
});

describe("pasting into another project", () => {
  beforeEach(() => {
    copies.length = 0;
    useEditor.setState({
      projectId: "p2",
      clips: [],
      transitions: [],
      audioClips: [],
      overlays: [],
      assets: [],
      subtitles: emptySubtitles(),
      selection: null,
      multiSelection: [],
    });
    setPlayhead(2);
  });

  test("brings the media across once and lands the items on it", async () => {
    const payload = payloadOf(["c0", "a0", "s1", "t1", "q0"]);
    expect(await pasteCutPayload(payload, { projectId: "p2", at: 2, library: EMPTY_LIBRARY })).toBe(true);
    const s = useEditor.getState();
    expect(copies.sort()).toEqual(["arrow.png", "brand.ttf", "clip-0.mp4", "music.m4a"]);
    expect(s.assets).toHaveLength(4);
    expect(s.assets.every((a) => a.copiedFrom?.projectId === "rich")).toBe(true);
    const footage = s.assets.find((a) => a.copiedFrom?.assetId === "v0")!;
    // The notes and transcript written against the source came with it.
    expect(footage.watch?.notes).toHaveLength(1);
    expect(footage.speech?.segments).toHaveLength(1);
    expect(s.clips).toHaveLength(1);
    expect(s.clips[0]).toMatchObject({ assetId: footage.id, start: 2, speed: 1.25 });
    expect(s.audioClips[0].assetId).toBe(s.assets.find((a) => a.copiedFrom?.assetId === "m0")!.id);
    const sticker = s.overlays.find(isStickerOverlay)!;
    expect(sticker.assetId).toBe(s.assets.find((a) => a.copiedFrom?.assetId === "s0")!.id);
    const title = s.overlays.find(isTextOverlay)!;
    expect(title.font).toBe(`asset:${s.assets.find((a) => a.type === "font")!.id}`);
    expect(s.subtitles.cues).toHaveLength(1);
    expect(s.subtitles.cues[0]).toMatchObject({ start: 2, text: "every feature" });

    // Pasting the same copy again finds the media already here.
    copies.length = 0;
    expect(await pasteCutPayload(payload, { projectId: "p2", at: 20, library: EMPTY_LIBRARY })).toBe(true);
    expect(copies).toEqual([]);
    expect(useEditor.getState().assets).toHaveLength(4);
    expect(useEditor.getState().clips).toHaveLength(2);
  });

  test("a keyed clip arrives without its removal, and a generated source lands as the user's import", async () => {
    const clip = { ...rich.clips![0], removal: { mode: "auto", requested: true } as unknown as NonNullable<VideoClip["removal"]> };
    const payload: CutClipboardPayload = {
      v: 1,
      projectId: "rich",
      items: [{ kind: "clip", item: clip }, { kind: "audio", item: rich.audioClips![0] }],
      assets: storedAssets(richAssets.filter((a) => a.id === "v0" || a.id === "m0")),
    };
    expect(await pasteCutPayload(payload, { projectId: "p2", at: 2, library: EMPTY_LIBRARY })).toBe(true);
    const s = useEditor.getState();
    expect(s.clips[0].removal).toBeUndefined();
    // The music was generated in the source; here it is a file the user brought in.
    const music = s.assets.find((a) => a.copiedFrom?.assetId === "m0")!;
    expect(music.origin).toBeUndefined();
    expect(music.beats?.bpm).toBe(120);
  });

  test("a sticker stays a sticker when it crosses", async () => {
    const payload: CutClipboardPayload = { v: 1, projectId: "rich", items: [], assets: storedAssets(richAssets.filter((a) => a.id === "s0")) };
    expect(await pasteCutPayload(payload, { projectId: "p2", at: 2, library: EMPTY_LIBRARY })).toBe(true);
    const s = useEditor.getState();
    expect(s.assets[0].origin).toBe("sticker");
    expect(s.overlays.some(isStickerOverlay)).toBe(true);
  });

  test("a project that closes while the media lands takes none of it", async () => {
    setHostDocStore({
      readDoc: async (id) => docs.get(id) ?? null,
      copyMedia: async (_src, file) => {
        // The user switched projects while the bytes were on their way.
        useEditor.setState({ projectId: "p3", assets: [], clips: [] });
        return `copy-${file}`;
      },
    });
    try {
      await expect(pasteCutPayload(payloadOf(["c0"]), { projectId: "p2", at: 2, library: EMPTY_LIBRARY })).rejects.toThrow(
        "The project closed"
      );
      expect(useEditor.getState().assets).toHaveLength(0);
      expect(useEditor.getState().clips).toHaveLength(0);
    } finally {
      setHostDocStore({
        readDoc: async (id) => docs.get(id) ?? null,
        copyMedia: async (_src, file) => {
          copies.push(file);
          return `copy-${file}`;
        },
      });
    }
  });

  test("a copied card lands its asset the way its + button does", async () => {
    const payload: CutClipboardPayload = { v: 1, projectId: "rich", items: [], assets: storedAssets(richAssets.filter((a) => a.id === "v1")) };
    expect(await pasteCutPayload(payload, { projectId: "p2", at: 2, library: EMPTY_LIBRARY })).toBe(true);
    const s = useEditor.getState();
    expect(s.assets).toHaveLength(1);
    expect(s.clips).toHaveLength(1);
    expect(s.clips[0].assetId).toBe(s.assets[0].id);
  });

  test("in the project the copy came from, the items paste as a same-tab copy would", async () => {
    useEditor.setState({ projectId: "rich", assets: richAssets });
    expect(await pasteCutPayload(payloadOf(["t0"]), { projectId: "rich", at: 2, library: EMPTY_LIBRARY })).toBe(true);
    expect(copies).toEqual([]);
    expect(useEditor.getState().overlays).toHaveLength(1);
    // A card copy from this same project is its tokens' to place.
    const card: CutClipboardPayload = { v: 1, projectId: "rich", items: [], assets: storedAssets(richAssets) };
    expect(await pasteCutPayload(card, { projectId: "rich", at: 2, library: EMPTY_LIBRARY })).toBe(false);
  });

  test("a paste aimed at a project no longer open lands nothing", async () => {
    expect(await pasteCutPayload(payloadOf(["c0"]), { projectId: "p9", at: 2, library: EMPTY_LIBRARY })).toBe(false);
    expect(useEditor.getState().clips).toHaveLength(0);
  });

  test("a source project nothing can open is a plain error", async () => {
    await expect(pasteCutPayload(payloadOf(["c0"], "gone"), { projectId: "p2", at: 2, library: EMPTY_LIBRARY })).rejects.toThrow(
      "No project with id gone"
    );
  });
});
