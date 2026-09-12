import { beforeEach, describe, expect, test } from "bun:test";

import { richDoc } from "./fixtures/richDoc";
import { ITEM_KINDS, ITEM_KIND_IDS, clipboardItemAcross, clipboardItemAssetIds, clipboardItemFor, listedAssetIds, type ItemKind, type ItemOf } from "./itemKinds";
import { payloadAssets } from "./cutClipboard";
import { setPlayhead } from "./playhead";
import { assetIdsInUse, useEditor } from "./store";
import { emptySubtitles, type MediaAsset, type Selection } from "./types";

/**
 * Every kind of item the timeline can select is one entry in the item-kind
 * table, and the table is what copy, paste, the cross-project paste, the
 * template rail and the media collector read. This walks the table with one
 * sample of each kind, so an entry that cannot copy, paste, remap or leave
 * its project fails here — and a kind added to `Selection` without an entry
 * fails to compile, in the table and in `SAMPLES` below.
 */

const rich = richDoc();

/** One of each kind out of the fixture, with its expected asset ids. */
const SAMPLES: { [K in ItemKind]: { id: string; assets: string[] } } = {
  clip: { id: "c0", assets: ["v0"] },
  audio: { id: "a0", assets: ["m0"] },
  overlay: { id: "t1", assets: ["f0"] },
  cue: { id: "q0", assets: [] },
  transition: { id: "tr0", assets: [] },
};

const lists = () => ({
  clips: rich.clips!,
  audioClips: rich.audioClips!,
  overlays: rich.overlays!,
  transitions: rich.transitions!,
  subtitles: { cues: rich.subtitles!.cues },
});

describe("the item-kind table", () => {
  test("every selectable kind has an entry and a sample", () => {
    expect(ITEM_KIND_IDS.sort()).toEqual((Object.keys(SAMPLES) as ItemKind[]).sort());
  });

  for (const kind of ITEM_KIND_IDS) {
    const sample = SAMPLES[kind];
    test(`${kind}: names its assets, remaps every one of them, and clones apart`, () => {
      const cb = clipboardItemFor(lists(), { kind, id: sample.id } as NonNullable<Selection>)!;
      expect(cb).not.toBeNull();
      expect(cb.kind).toBe(kind);
      expect(clipboardItemAssetIds(cb).sort()).toEqual([...sample.assets].sort());
      // The clone shares nothing with the list's own item.
      const original = (ITEM_KINDS[kind].list(lists()) as { id: string }[]).find((x) => x.id === sample.id)!;
      expect(cb.item).toEqual(original as ItemOf[typeof kind]);
      expect(cb.item).not.toBe(original);
      // Every id the kind reports is an id the remap rewrites, and nothing else moves.
      const across = clipboardItemAcross(cb, (id) => `${id}-b`);
      expect(clipboardItemAssetIds(across).sort()).toEqual(sample.assets.map((id) => `${id}-b`).sort());
      const back = clipboardItemAcross(across, (id) => id.replace(/-b$/, ""));
      expect(clipboardItemAssetIds(back).sort()).toEqual([...sample.assets].sort());
    });
  }

  test("what crosses a project boundary never names an asset that stays behind", () => {
    const clip = { ...rich.clips![0], removal: { matte: { assetId: "matte-1" } } } as unknown as ItemOf["clip"];
    expect(ITEM_KINDS.clip.assetIds(clip)).toEqual(["v0", "matte-1"]);
    const across = ITEM_KINDS.clip.crossProject(clip);
    expect(ITEM_KINDS.clip.assetIds(across)).toEqual(["v0"]);
    for (const kind of ITEM_KIND_IDS) {
      const cb = clipboardItemFor(lists(), { kind, id: SAMPLES[kind].id } as NonNullable<Selection>)!;
      const stays = new Set(clipboardItemAssetIds(cb));
      for (const id of clipboardItemAssetIds(clipboardItemAcross(cb, (id) => id))) expect(stays.has(id)).toBe(true);
    }
  });

  test("the media collector, the clipboard and the table agree on what a timeline names", () => {
    const l = lists();
    const fromTable = listedAssetIds(l);
    expect(assetIdsInUse({ ...l, subtitles: { ...l.subtitles, font: rich.subtitles!.font } })).toEqual(fromTable);
    const items = ITEM_KIND_IDS.map((kind) => clipboardItemFor(l, { kind, id: SAMPLES[kind].id } as NonNullable<Selection>)!);
    const assets: MediaAsset[] = rich.assets.map((a) => ({ ...a, url: "" }));
    const carried = new Set(payloadAssets(items, assets).map((a) => a.id));
    for (const cb of items) for (const id of clipboardItemAssetIds(cb)) expect(carried.has(id)).toBe(true);
  });
});

describe("copy and paste, kind by kind", () => {
  beforeEach(() => {
    useEditor.setState({
      projectId: "rich",
      assets: rich.assets.map((a) => ({ ...a, url: "" })),
      clips: rich.clips!,
      transitions: rich.transitions!,
      audioClips: rich.audioClips!,
      overlays: rich.overlays!,
      subtitles: rich.subtitles!,
      selection: null,
      multiSelection: [],
    });
    setPlayhead(30);
  });

  for (const kind of ITEM_KIND_IDS) {
    test(`${kind} copies and pastes as a new item`, () => {
      const s = useEditor.getState();
      const sel = { kind, id: SAMPLES[kind].id } as NonNullable<Selection>;
      useEditor.setState({ selection: sel, multiSelection: [sel] });
      const before = ITEM_KINDS[kind].list(s).length;
      expect(s.copySelection()).toBe(true);
      expect(s.paste()).toBe(true);
      const after = useEditor.getState();
      const list = ITEM_KINDS[kind].list(after) as { id: string }[];
      expect(list).toHaveLength(before + 1);
      const fresh = after.selection!;
      expect(fresh.kind).toBe(kind);
      expect(fresh.id).not.toBe(SAMPLES[kind].id);
      expect(list.some((x) => x.id === fresh.id)).toBe(true);
    });
  }

  test("the empty caption track pastes a cue too", () => {
    useEditor.setState({ subtitles: emptySubtitles() });
    useEditor.getState().setClipboard([{ kind: "cue", item: rich.subtitles!.cues[0] }]);
    expect(useEditor.getState().paste()).toBe(true);
    expect(useEditor.getState().subtitles.cues).toHaveLength(1);
  });
});
