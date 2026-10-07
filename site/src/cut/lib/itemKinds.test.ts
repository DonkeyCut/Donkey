import { beforeEach, describe, expect, test } from "bun:test";

import { richDoc } from "./fixtures/richDoc";
import { ITEM_KINDS, ITEM_KIND_IDS, clipboardItemAcross, clipboardItemAssetIds, clipboardItemFor, listedAssetIds, type ItemKind, type ItemOf } from "./itemKinds";
import { payloadAssets } from "./cutClipboard";
import { setPlayhead } from "./playhead";
import { assetIdsInUse, useEditor } from "./store";
import { clipPoseAt, emptySubtitles, type MediaAsset, type Selection } from "./types";

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
      expect(list).toHaveLength(before + s.copiedItems().filter((item) => item.kind === kind).length);
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

describe("pictureAssetIds", () => {
  test("names what the frame draws and leaves the soundtrack and the shelf out", async () => {
    const { drawnLists, pictureAssetIds } = await import("./itemKinds");
    const doc = {
      clips: [{ assetId: "base", removal: { matte: { assetId: "matte" } } }],
      overlayClips: [{ assetId: "upper" }],
      overlays: [{ kind: "sticker", assetId: "sticker" }],
      audioClips: [{ assetId: "song" }],
    } as never;
    expect([...pictureAssetIds(drawnLists(doc))].sort()).toEqual(["base", "matte", "sticker", "upper"]);
  });
});

describe("splitting keyed items", () => {
  const poseKey = (t: number, x: number) => ({ t, x, y: 0.5, scale: 1, rotation: 0, opacity: 1 });
  const maskKey = (t: number, x: number) => ({ t, x, y: 0, w: 0.5, h: 0.5, rotation: 0, feather: 0 });

  test("a clip's pose and mask keys keep their timing in both halves", () => {
    const clip = {
      id: "k1", assetId: "v0", start: 10, in: 0, out: 4, track: 1,
      kf: [poseKey(0, 0.2), poseKey(4, 0.6)],
      mask: { kind: "rect" as const, kf: [maskKey(0, 0), maskKey(4, 0.4)] },
    };
    const [left, right] = ITEM_KINDS.clip.split!(clip as never, 12);
    // Halfway through the original is the right half's first frame.
    expect(right.kf![0]).toMatchObject({ t: 0, x: 0.4 });
    expect(right.kf![right.kf!.length - 1]).toMatchObject({ t: 2, x: 0.6 });
    expect(right.mask!.kf![0]).toMatchObject({ t: 0, x: 0.2 });
    expect(left.kf![left.kf!.length - 1]).toMatchObject({ t: 2, x: 0.4 });
    expect(left.mask!.kf![left.mask!.kf!.length - 1]).toMatchObject({ t: 2, x: 0.2 });
  });

  test("an element's pose and mask keys keep their timing in both halves", () => {
    const o = {
      id: "k2", kind: "shape", start: 0, end: 4, x: 0.5, y: 0.5,
      kf: [poseKey(0, 0.2), poseKey(4, 0.6)],
      mask: { kind: "rect" as const, kf: [maskKey(0, 0), maskKey(4, 0.4)] },
    };
    const [, right] = ITEM_KINDS.overlay.split!(o as never, 1);
    expect(right.kf![0]).toMatchObject({ t: 0, x: 0.3 });
    expect(right.mask!.kf![0]).toMatchObject({ t: 0, x: 0.1 });
  });

  test("a clip's effects carry on through the cut", () => {
    const clip = { id: "e1", assetId: "v0", start: 10, in: 0, out: 4, track: 0, effects: [{ effect: "huecycle" }], effectsFrom: 0.5 };
    const [left, right] = ITEM_KINDS.clip.split!(clip as never, 12);
    expect(left.effectsFrom).toBe(0.5);
    expect(right.effectsFrom).toBeCloseTo(2.5, 9);
  });

  test("an eased move keeps its curve on both sides of the cut", () => {
    const clip = {
      id: "e2", assetId: "v0", start: 0, in: 0, out: 4, track: 1,
      kf: [{ ...poseKey(0, 0), ease: "sine.inOut" as const }, poseKey(4, 1)],
    };
    const whole = (t: number) => clipPoseAt(clip as never, t).x;
    const [left, right] = ITEM_KINDS.clip.split!(clip as never, 1);
    for (const t of [0.25, 0.5, 0.9]) expect(clipPoseAt(left, t).x).toBeCloseTo(whole(t), 2);
    for (const t of [0.2, 1, 2.5]) expect(clipPoseAt(right, t).x).toBeCloseTo(whole(1 + t), 2);
  });

  test("a clip's mask keys stay on its footage through a head trim and a speed change", () => {
    const key = (t: number) => ({ t, x: 0, y: 0, w: 0.5, h: 0.5, rotation: 0, feather: 0 });
    const clip = { id: "m1", assetId: "v0", start: 0, in: 0, out: 4, track: 0, muted: false, mask: { kind: "rect" as const, kf: [key(1), key(3)] } };
    useEditor.setState({ clips: [clip] });
    useEditor.getState().updateClipTransient("m1", { start: 0.5, in: 0.5 });
    expect(useEditor.getState().clips[0].mask!.kf!.map((k) => k.t)).toEqual([0.5, 2.5]);
    useEditor.getState().setClipSpeed("m1", 2);
    expect(useEditor.getState().clips[0].mask!.kf!.map((k) => k.t)).toEqual([0.25, 1.25]);
  });

  test("an element's press stays at its moment on the timeline", () => {
    const o = {
      id: "h1", kind: "shape", start: 0, end: 4, x: 0.5, y: 0.5,
      anim: { hit: { style: "press", at: 2.5, seconds: 0.3 } },
    };
    const [left, right] = ITEM_KINDS.overlay.split!(o as never, 1);
    expect(left.anim?.hit).toBeUndefined();
    expect(right.anim!.hit!.at).toBeCloseTo(1.5, 9);
    const [early, late] = ITEM_KINDS.overlay.split!(o as never, 3);
    expect(early.anim!.hit!.at).toBe(2.5);
    expect(late.anim?.hit).toBeUndefined();
  });
});
