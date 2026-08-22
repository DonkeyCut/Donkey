import { describe, expect, test } from "bun:test";
import { entityRefs, selectionRefTokens, type EntitySources } from "./assetRef";
import type { MediaAsset, Overlay, VideoClip } from "./types";

const asset = (id: string): MediaAsset =>
  ({ id, name: `${id}.mp4`, type: "video", url: `/media/${id}.mp4`, duration: 10 }) as MediaAsset;

const clip = (id: string, start: number, patch: Partial<VideoClip> = {}): VideoClip => ({
  id,
  assetId: id,
  track: 0,
  start,
  in: 0,
  out: 4,
  muted: false,
  ...patch,
});

const key = (t: number) => ({ t, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 });

const title = (id: string, start: number, patch: Partial<Overlay> = {}): Overlay =>
  ({
    id,
    start,
    end: start + 3,
    x: 0.5,
    y: 0.5,
    text: "Hello",
    size: 64,
    font: "sf",
    weight: 700,
    color: "#fff",
    ...patch,
  }) as Overlay;

const sources = (patch: Partial<EntitySources> = {}): EntitySources => ({
  clips: [],
  assets: [],
  overlays: [],
  transitions: [],
  subtitles: { cues: [] },
  ...patch,
});

describe("entityRefs", () => {
  test("elements name by content and carry ids in the payload", () => {
    const refs = entityRefs(
      sources({
        assets: [
          {
            id: "img-1",
            name: "make the clothes blue.png",
            type: "image",
            url: "/media/img-1.png",
          } as MediaAsset,
        ],
        overlays: [
          title("ov-b", 4, { text: "Snap Test" }),
          title("ov-a", 0),
          title("sh-1", 2, { kind: "shape", shape: "rect" } as Partial<Overlay>),
          title("fx-1", 5, { kind: "effect", effect: "vhs" } as Partial<Overlay>),
          title("st-1", 6, { kind: "sticker", assetId: "img-1" } as Partial<Overlay>),
        ],
        transitions: [{ id: "tr-1", start: 3, seconds: 0.5, style: "crossfade" }],
        subtitles: { cues: [{ id: "cue-1", start: 1, end: 2, text: "hi there" }] },
      })
    );
    const names = refs.map((r) => r.name);
    expect(names).toEqual([
      "Hello",
      "Rectangle",
      "Snap Test",
      "VHS",
      "Sticker",
      "Cross fade",
      "cue 1",
    ]);
    // A sticker names by kind — its prompt-shaped asset name stays out of the
    // token — and carries its art for the pill.
    const st = refs.find((r) => r.name === "Sticker")!;
    expect(st.entityKind).toBe("sticker");
    expect(st.preview).toBe("/media/img-1.png");
    const t1 = refs.find((r) => r.name === "Hello")!;
    expect(t1.id).toBe("overlay:ov-a");
    expect(t1.kind).toBe("text");
    expect(decodeURIComponent(t1.url)).toContain("id ov-a");
    expect(decodeURIComponent(t1.url)).toContain('Text: "Hello"');
    expect(t1.entityKind).toBe("title");
    const rect = refs.find((r) => r.name === "Rectangle")!;
    expect(rect.entityKind).toBe("shape");
    expect(rect.shapeKind).toBe("rect");
    // A bar reads the way its own label on the row reads, and carries the
    // style so its pill wears the icon the bar wears.
    const bar = refs.find((r) => r.name === "Cross fade")!;
    expect(bar.entityKind).toBe("transition");
    expect(bar.transitionStyle).toBe("crossfade");
    // An effect carries its treatment, which is what splits the waveform from
    // the sparkles.
    expect(refs.find((r) => r.name === "VHS")!.effectId).toBe("vhs");
  });

  test("two bars of one style number, one of a kind does not", () => {
    const refs = entityRefs(
      sources({
        transitions: [
          { id: "tr-1", start: 1, seconds: 0.5, style: "audiocross" },
          { id: "tr-3", start: 5, seconds: 0.5, style: "audiocross" },
          { id: "tr-2", start: 3, seconds: 0.5, style: "dipblack" },
        ],
      })
    );
    expect(refs.map((r) => r.name)).toEqual(["Cross dissolve 1", "Dip to black", "Cross dissolve 2"]);
  });

  test("names number in timeline order only on collision", () => {
    const refs = entityRefs(
      sources({
        overlays: [
          title("sh-b", 4, { kind: "shape", shape: "rect" } as Partial<Overlay>),
          title("sh-a", 0, { kind: "shape", shape: "rect" } as Partial<Overlay>),
          title("sh-c", 2, { kind: "shape", shape: "star" } as Partial<Overlay>),
          title("ov-a", 6, { text: "  " }),
        ],
      })
    );
    expect(refs.map((r) => r.name)).toEqual(["Rectangle 1", "Star", "Rectangle 2", "title"]);
    expect(refs.find((r) => r.name === "Rectangle 1")!.id).toBe("overlay:sh-a");
  });

  test("keyframes number per track under their parent's display name", () => {
    const refs = entityRefs(
      sources({
        clips: [clip("c-a", 0, { kf: [key(1), key(0.2)] })],
        assets: [asset("c-a")],
        overlays: [
          title("ov-a", 0, {
            kf: [key(0.5)],
            mask: { kind: "circle", kf: [{ t: 0, x: 0, y: 0, w: 0.5, h: 0.5, rotation: 0, feather: 0 }] },
          } as Partial<Overlay>),
        ],
      })
    );
    const names = refs.map((r) => r.name);
    expect(names).toContain("kf1 c1");
    expect(names).toContain("kf2 c1");
    expect(names).toContain("kf Hello");
    expect(names).toContain("mask kf Hello");
    expect(refs.find((r) => r.name === "kf Hello")!.keyTrack).toBe("pose");
    expect(refs.find((r) => r.name === "mask kf Hello")!.keyTrack).toBe("mask");
    // Keys sort by time: the 0.2s key is keyframe 1.
    const k1 = refs.find((r) => r.name === "kf1 c1")!;
    expect(k1.id).toBe("key:clip:c-a:pose:0");
    expect(decodeURIComponent(k1.url)).toContain("At 0.20s into the clip");
    expect(decodeURIComponent(k1.url)).toContain("clip id c-a");
  });
});

describe("selectionRefTokens", () => {
  const base = {
    clips: [clip("c-a", 0, { kf: [key(0.2), key(1)] })],
    assets: [asset("c-a")],
    audioClips: [],
    overlays: [title("ov-a", 0)],
    transitions: [{ id: "tr-1", start: 3, seconds: 0.5, style: "crossfade" as const }],
    subtitles: { cues: [{ id: "cue-1", start: 1, end: 2, text: "hi" }] },
    selection: null,
    multiSelection: [],
    selectedKey: null,
  };

  test("a picked keyframe wins and tokens by its ordinal under the parent", () => {
    const token = selectionRefTokens({
      ...base,
      selectedKey: { kind: "clip", id: "c-a", t: 1, track: "pose" },
    });
    // Entity tokens carry no-break spaces so the composer pill never wraps.
    expect(token).toBe('@"kf2 c1"');
  });

  test("selected clips, elements, transitions, and cues each token", () => {
    const token = selectionRefTokens({
      ...base,
      multiSelection: [
        { kind: "clip", id: "c-a" },
        { kind: "overlay", id: "ov-a" },
        { kind: "transition", id: "tr-1" },
        { kind: "cue", id: "cue-1" },
      ],
    });
    expect(token).toBe('@c1 @"Hello" @"Cross fade" @"cue 1"');
  });

  test("nothing resolvable yields null", () => {
    expect(selectionRefTokens({ ...base, selection: { kind: "clip", id: "gone" } })).toBe(null);
  });
});
