import { beforeEach, describe, expect, test } from "bun:test";

import { runAiTool } from "./aiTools";
import { canAdjust, selectedTarget, targetTakes } from "./replaceItem";
import { useEditor } from "./store";
import type { AudioClip, MediaAsset, Overlay, VideoClip } from "./types";

/** Replacing an item's media: a clip keeps its slot and plays the new source
 * from a chosen second, and a box shape or a sticker given footage becomes a
 * clip framed to the element's box. */

const asset = (id: string, type: MediaAsset["type"], duration: number, over: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  fileName: `${id}.${type === "image" ? "png" : type === "audio" ? "m4a" : "mp4"}`,
  name: id,
  type,
  duration,
  url: "",
  ...over,
});

const clip = (over: Partial<VideoClip> = {}): VideoClip =>
  ({ id: "c", assetId: "old", track: 0, start: 2, in: 0, out: 3, muted: false, ...over }) as VideoClip;

const shape = (over: Record<string, unknown> = {}): Overlay =>
  ({
    id: "s",
    kind: "shape",
    shape: "ellipse",
    start: 4,
    end: 7,
    x: 0.5,
    y: 0.4,
    w: 0.3,
    h: 0.2,
    fill: "#ff0000",
    rotation: 12,
    ...over,
  }) as Overlay;

beforeEach(() => {
  useEditor.setState({
    projectId: "p1",
    loaded: true,
    aspect: "16:9",
    clips: [],
    transitions: [],
    audioClips: [],
    overlays: [],
    assets: [
      asset("old", "video", 30),
      asset("long", "video", 10),
      asset("short", "video", 1),
      asset("photo", "image", 0, { width: 400, height: 200 }),
      asset("song", "audio", 60),
      asset("tune", "audio", 20),
      asset("logo", "image", 0, { width: 100, height: 100 }),
    ],
    selection: null,
    multiSelection: [],
  });
});

const only = <T,>(list: T[]): T => {
  expect(list.length).toBe(1);
  return list[0];
};

describe("replacing a clip's source", () => {
  test("the new source plays from the chosen second for the slot's length", () => {
    useEditor.setState({ clips: [clip()] });
    useEditor.getState().replaceClipAsset("c", "long", { from: 4 });
    expect(only(useEditor.getState().clips)).toMatchObject({ assetId: "long", start: 2, in: 4, out: 7 });
  });

  test("an in-point past what fits is held inside the source", () => {
    useEditor.setState({ clips: [clip()] });
    useEditor.getState().replaceClipAsset("c", "long", { from: 9 });
    expect(only(useEditor.getState().clips)).toMatchObject({ in: 7, out: 10 });
  });

  test("without an in-point the source plays from its head", () => {
    useEditor.setState({ clips: [clip()] });
    useEditor.getState().replaceClipAsset("c", "long");
    expect(only(useEditor.getState().clips)).toMatchObject({ in: 0, out: 3 });
  });

  test("a soundtrack clip takes the same in-point", () => {
    const a: AudioClip = { id: "a", assetId: "song", start: 0, in: 0, out: 5 } as AudioClip;
    useEditor.setState({ audioClips: [a] });
    useEditor.getState().replaceAudioAsset("a", "tune", 18);
    expect(only(useEditor.getState().audioClips)).toMatchObject({ assetId: "tune", in: 15, out: 20 });
  });

  test("replace_item passes `from` through", async () => {
    useEditor.setState({ clips: [clip()] });
    await runAiTool("replace_item", { id: "c", asset_id: "long", from: 5 });
    expect(only(useEditor.getState().clips)).toMatchObject({ in: 5, out: 8 });
  });
});

describe("a shape takes footage", () => {
  test("it becomes a clip on a new top track, framed to its box, its outline the mask", () => {
    useEditor.setState({ clips: [clip()], overlays: [shape()] });
    const id = useEditor.getState().overlayToClip("s", "long", 2);
    const s = useEditor.getState();
    expect(s.overlays).toEqual([]);
    const placed = s.clips.find((c) => c.id === id)!;
    expect(placed).toMatchObject({ assetId: "long", track: 1, start: 4, in: 2, out: 5, fit: "fill", rotation: 12 });
    expect(placed.frame!.x).toBeCloseTo(0.35);
    expect(placed.frame!.y).toBeCloseTo(0.3);
    expect(placed.frame).toMatchObject({ w: 0.3, h: 0.2 });
    expect(placed.mask).toEqual({ kind: "circle", w: 0.3, h: 0.2 });
    expect(s.selection).toEqual({ kind: "clip", id: id! });
  });

  test("a rounded rect keeps its corners; a square one needs no mask", () => {
    useEditor.setState({ overlays: [shape({ id: "r", shape: "rect", radius: 24 }), shape({ id: "q", shape: "rect" })] });
    const r = useEditor.getState().overlayToClip("r", "photo");
    const q = useEditor.getState().overlayToClip("q", "photo");
    const clips = useEditor.getState().clips;
    expect(clips.find((c) => c.id === r)!.mask).toEqual({ kind: "rect", w: 0.3, h: 0.2, radius: 24 });
    expect(clips.find((c) => c.id === q)!.mask).toBeUndefined();
  });

  test("a still holds the element's whole span; short footage runs out early", () => {
    useEditor.setState({ overlays: [shape({ id: "a" }), shape({ id: "b" })] });
    const still = useEditor.getState().overlayToClip("a", "photo");
    const brief = useEditor.getState().overlayToClip("b", "short");
    const clips = useEditor.getState().clips;
    expect(clips.find((c) => c.id === still)).toMatchObject({ in: 0, out: 3 });
    expect(clips.find((c) => c.id === brief)).toMatchObject({ in: 0, out: 1 });
  });

  test("an empty timeline takes it on track 0", () => {
    useEditor.setState({ overlays: [shape()] });
    useEditor.getState().overlayToClip("s", "photo");
    expect(only(useEditor.getState().clips).track).toBe(0);
  });

  test("one undo puts the shape back", () => {
    useEditor.setState({ clips: [clip()], overlays: [shape()] });
    useEditor.getState().overlayToClip("s", "long");
    useEditor.getState().undo();
    const s = useEditor.getState();
    expect(s.overlays.map((o) => o.id)).toEqual(["s"]);
    expect(s.clips.map((c) => c.id)).toEqual(["c"]);
  });

  test("a stroke shape has no box to fill", async () => {
    useEditor.setState({ overlays: [shape({ shape: "line" })] });
    expect(useEditor.getState().overlayToClip("s", "photo")).toBeNull();
    await expect(runAiTool("replace_item", { id: "s", asset_id: "photo" })).rejects.toThrow();
    expect(useEditor.getState().overlays.length).toBe(1);
  });

  test("replace_item puts footage in a shape's place and names the new clip", async () => {
    useEditor.setState({ overlays: [shape()] });
    const out = (await runAiTool("replace_item", { id: "s", asset_id: "long", from: 1 })) as { id: string; kind: string };
    expect(out.kind).toBe("clip");
    expect(only(useEditor.getState().clips)).toMatchObject({ id: out.id, in: 1, out: 4 });
  });
});

describe("a sticker", () => {
  const sticker = (over: Record<string, unknown> = {}): Overlay =>
    ({ id: "k", kind: "sticker", assetId: "logo", start: 0, end: 2, x: 0.5, y: 0.5, w: 0.2, ...over }) as Overlay;

  test("a still replaces it in place", async () => {
    useEditor.setState({ overlays: [sticker()] });
    await runAiTool("replace_item", { id: "k", asset_id: "photo" });
    const s = useEditor.getState();
    expect(s.clips).toEqual([]);
    expect(only(s.overlays)).toMatchObject({ id: "k", assetId: "photo" });
  });

  test("footage turns it into a clip at its image's aspect", () => {
    useEditor.setState({ overlays: [sticker()] });
    const id = useEditor.getState().overlayToClip("k", "long");
    const placed = useEditor.getState().clips.find((c) => c.id === id)!;
    // A square image 0.2 of a 16:9 frame wide is 0.2 × 16/9 of its height tall.
    expect(placed.frame!.w).toBeCloseTo(0.2);
    expect(placed.frame!.h).toBeCloseTo((0.2 * 16) / 9);
    expect(placed.mask).toBeUndefined();
    expect(useEditor.getState().overlays).toEqual([]);
  });
});

describe("adjusting which part a clip plays", () => {
  test("a file longer than the part the clip plays has another part to choose", () => {
    expect(canAdjust(asset("long", "video", 10), { in: 2, out: 5 })).toBe(true);
    expect(canAdjust(asset("song", "audio", 60), { in: 0, out: 5 })).toBe(true);
  });

  test("a still, a file played whole and an empty shot have none", () => {
    expect(canAdjust(asset("photo", "image", 0), { in: 0, out: 3 })).toBe(false);
    expect(canAdjust(asset("short", "video", 3), { in: 0, out: 3 })).toBe(false);
    expect(canAdjust(asset("b", "video", 10, { block: { label: "Shot" } }), { in: 0, out: 3 })).toBe(false);
  });
});

describe("what a paste replaces", () => {
  test("the one selected clip, soundtrack clip or box shape", () => {
    const overlays = [shape(), shape({ id: "l", shape: "line" })];
    const one = (sel: { kind: "clip" | "audio" | "overlay" | "cue"; id: string }) =>
      selectedTarget({ selection: sel, multiSelection: [sel], overlays });
    expect(one({ kind: "clip", id: "c" })).toEqual({ kind: "clip", id: "c" });
    expect(one({ kind: "audio", id: "a" })).toEqual({ kind: "audio", id: "a" });
    expect(one({ kind: "overlay", id: "s" })).toEqual({ kind: "overlay", id: "s" });
    expect(one({ kind: "overlay", id: "l" })).toBeNull();
    expect(one({ kind: "cue", id: "q" })).toBeNull();
  });

  test("nothing when several items are selected", () => {
    const a = { kind: "clip" as const, id: "c" };
    const b = { kind: "clip" as const, id: "d" };
    expect(selectedTarget({ selection: a, multiSelection: [a, b], overlays: [] })).toBeNull();
  });

  test("footage and stills go in clips and shapes; sound, or a video's sound, in soundtrack clips", () => {
    expect(targetTakes({ kind: "clip", id: "c" }, "video")).toBe(true);
    expect(targetTakes({ kind: "overlay", id: "s" }, "image")).toBe(true);
    expect(targetTakes({ kind: "clip", id: "c" }, "audio")).toBe(false);
    expect(targetTakes({ kind: "audio", id: "a" }, "audio")).toBe(true);
    expect(targetTakes({ kind: "audio", id: "a" }, "video")).toBe(true);
    expect(targetTakes({ kind: "audio", id: "a" }, "image")).toBe(false);
  });

  test("a soundtrack clip given a video plays its sound", () => {
    const a: AudioClip = { id: "a", assetId: "song", start: 0, in: 0, out: 5 } as AudioClip;
    useEditor.setState({ audioClips: [a] });
    useEditor.getState().replaceAudioAsset("a", "long", 2);
    expect(only(useEditor.getState().audioClips)).toMatchObject({ assetId: "long", in: 2, out: 7 });
  });
});
