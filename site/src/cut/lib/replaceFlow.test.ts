import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as media from "./media";
import { EMPTY_LIBRARY, refFromAsset, refFromStockSfx } from "./assetRef";
import type { StockSfx } from "./stock";
import { useEditor } from "./store";
import type { TimelineClipboardItem } from "./itemKinds";
import type { AudioClip, MediaAsset, Overlay, VideoClip } from "./types";

/** ⌘C on a card, select an item, ⌘V: the copied file replaces the item where
 * it stands, and the adjuster opens when the file runs longer than the item.
 * A sound effect is copied off the stock shelf, so it comes into the project
 * first. */

// Stock imports go over the network; here they land straight in the store.
mock.module("./media", () => ({
  ...media,
  importStockAudio: async (_projectId: string, music: { url: string; name: string; duration?: number }) => {
    const landed: MediaAsset = {
      id: `stock-${music.name}`,
      fileName: `${music.name}.mp3`,
      name: music.name,
      type: "audio",
      duration: music.duration ?? 0,
      url: music.url,
      origin: "stock",
    };
    useEditor.setState((s) => ({ assets: [...s.assets, landed] }));
    return landed;
  },
}));

const { pasteItemOnto, pasteRefs, useReplaceTarget } = await import("./replaceFlow");

const sfx = (id: string, duration: number): StockSfx => ({
  id,
  category: "Essentials",
  prompt: id,
  tags: [],
  file: `https://media.example/${id}.mp3`,
  duration,
  peaks: [],
});

const whoosh = { id: "whoosh", fileName: "whoosh.mp3", name: "whoosh", type: "audio", duration: 2, url: "" } as MediaAsset;
const ding: AudioClip = { id: "a", assetId: "whoosh", start: 5, in: 0, out: 2 } as AudioClip;
const ctx = { projectId: "p1", library: EMPTY_LIBRARY, at: 20 };

beforeEach(() => {
  useEditor.setState({
    projectId: "p1",
    loaded: true,
    readOnly: false,
    clips: [],
    transitions: [],
    overlays: [],
    assets: [whoosh],
    audioClips: [ding],
    selection: { kind: "audio", id: "a" },
    multiSelection: [],
  });
  useReplaceTarget.setState({ target: null, mode: "replace" });
});

const clipA = () => useEditor.getState().audioClips.find((a) => a.id === "a");

describe("paste a sound effect onto a selected sound clip", () => {
  test("a shorter effect replaces it where it stands", async () => {
    await pasteRefs([refFromStockSfx(sfx("click", 0.5))], ctx);

    const a = clipA()!;
    expect(useEditor.getState().assets.find((x) => x.id === a.assetId)?.name).not.toBe("whoosh");
    expect(a.start).toBe(5);
    expect(a.out - a.in).toBeCloseTo(0.5);
    expect(useEditor.getState().audioClips).toHaveLength(1);
    expect(useReplaceTarget.getState().target).toBeNull();
  });

  test("a longer effect keeps the slot and opens the adjuster", async () => {
    await pasteRefs([refFromStockSfx(sfx("rumble", 6))], ctx);

    const a = clipA()!;
    expect(a.assetId).not.toBe("whoosh");
    expect(a.start).toBe(5);
    expect(a.out - a.in).toBeCloseTo(2);
    expect(useReplaceTarget.getState()).toEqual({ target: { kind: "audio", id: "a" }, mode: "adjust" });
  });

  test("with nothing selected it lands under the indicator", async () => {
    useEditor.setState({ selection: null });
    await pasteRefs([refFromStockSfx(sfx("click", 0.5))], ctx);

    const audio = useEditor.getState().audioClips;
    expect(clipA()?.assetId).toBe("whoosh");
    expect(audio).toHaveLength(2);
    expect(audio.find((a) => a.id !== "a")?.start).toBeCloseTo(20);
  });

  test("an animated sticker pasted onto a video clip lands as a sticker", async () => {
    const spin = { id: "spin", fileName: "spin.json", name: "spin", type: "image", duration: 0, url: "", origin: "sticker" } as MediaAsset;
    useEditor.setState({
      assets: [whoosh, spin, { id: "v", fileName: "v.mp4", name: "v", type: "video", duration: 9, url: "" } as MediaAsset],
      clips: [{ id: "c", assetId: "v", track: 0, start: 0, in: 0, out: 3, muted: false } as never],
      selection: { kind: "clip", id: "c" },
    });
    await pasteRefs([refFromAsset(spin)], ctx);

    const s = useEditor.getState();
    expect(s.clips).toHaveLength(1);
    expect(s.overlays).toMatchObject([{ kind: "sticker", assetId: "spin", lottie: true }]);
  });

  test("an effect pasted onto a video clip lands beside it", async () => {
    useEditor.setState({
      assets: [whoosh, { id: "v", fileName: "v.mp4", name: "v", type: "video", duration: 9, url: "" } as MediaAsset],
      clips: [{ id: "c", assetId: "v", track: 0, start: 0, in: 0, out: 3, muted: false } as never],
      selection: { kind: "clip", id: "c" },
    });
    await pasteRefs([refFromStockSfx(sfx("click", 0.5))], ctx);

    expect(useEditor.getState().clips[0].assetId).toBe("v");
    expect(useEditor.getState().audioClips).toHaveLength(2);
  });
});

describe("paste a copied timeline item onto a selected item", () => {
  const beach = { id: "beach", fileName: "beach.mp4", name: "beach", type: "video", duration: 20, url: "" } as MediaAsset;
  const old = { id: "old", fileName: "old.mp4", name: "old", type: "video", duration: 3, url: "" } as MediaAsset;
  const vclip = (id: string, assetId: string, start: number, inPt: number, out: number) =>
    ({ id, assetId, track: 0, start, in: inPt, out, muted: false }) as VideoClip;

  beforeEach(() => {
    useEditor.setState({
      assets: [whoosh, beach, old],
      clips: [vclip("c1", "old", 0, 0, 3), vclip("c2", "beach", 3, 4, 6)],
      selection: { kind: "clip", id: "c1" },
    });
  });

  const copyOf = (kind: "clip" | "audio", id: string): TimelineClipboardItem[] => {
    const s = useEditor.getState();
    const item = kind === "clip" ? s.clips.find((c) => c.id === id) : s.audioClips.find((a) => a.id === id);
    return [{ kind, item: { ...item! } } as TimelineClipboardItem];
  };

  test("a copied clip replaces the selected one where it stands, from the copy's second", () => {
    expect(pasteItemOnto({ kind: "clip", id: "c1" }, copyOf("clip", "c2"))).toBe(true);

    const s = useEditor.getState();
    const c1 = s.clips.find((c) => c.id === "c1")!;
    expect(s.clips).toHaveLength(2);
    expect(c1).toMatchObject({ assetId: "beach", start: 0, in: 4, out: 7 });
    expect(useReplaceTarget.getState()).toEqual({ target: { kind: "clip", id: "c1" }, mode: "adjust" });
  });

  test("a copied sound clip replaces the selected sound clip", () => {
    useEditor.setState({
      assets: [whoosh, { ...whoosh, id: "boom", name: "boom", duration: 1 }],
      audioClips: [ding, { ...ding, id: "b", assetId: "boom", start: 9, in: 0, out: 1 }],
    });
    expect(pasteItemOnto({ kind: "audio", id: "a" }, copyOf("audio", "b"))).toBe(true);

    expect(clipA()).toMatchObject({ assetId: "boom", start: 5, in: 0, out: 1 });
    expect(useEditor.getState().audioClips).toHaveLength(2);
  });

  test("the item pasted onto itself stays a duplicate", () => {
    expect(pasteItemOnto({ kind: "clip", id: "c1" }, copyOf("clip", "c1"))).toBe(false);
    expect(useEditor.getState().clips.find((c) => c.id === "c1")?.assetId).toBe("old");
  });

  test("⌘V again on the copy a paste selected lands another copy", () => {
    useEditor.setState({ clips: [...useEditor.getState().clips, vclip("c3", "beach", 6, 4, 6)] });
    expect(pasteItemOnto({ kind: "clip", id: "c3" }, copyOf("clip", "c2"))).toBe(false);
    expect(useReplaceTarget.getState().target).toBeNull();
  });

  test("a copied sound clip does not go in a video clip's place", () => {
    expect(pasteItemOnto({ kind: "clip", id: "c1" }, copyOf("audio", "a"))).toBe(false);
  });

  test("a copied title carries no file to replace with", () => {
    const title = { id: "t", kind: "text", text: "Hi", start: 0, end: 2 } as unknown as Overlay;
    expect(pasteItemOnto({ kind: "clip", id: "c1" }, [{ kind: "overlay", item: title } as TimelineClipboardItem])).toBe(false);
  });
});
