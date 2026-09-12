import { beforeEach, describe, expect, test } from "bun:test";

import { richDoc, RICH_CLIP_S } from "./fixtures/richDoc";
import { clampLayersToAssets, templateFromDoc } from "./projectTemplate";
import { resolveTransitions, useEditor } from "./store";
import { emptySubtitles, isStickerOverlay, isTextOverlay, type MediaAsset, type TemplateSaveInput } from "./types";

/**
 * The template rail carries a whole edit: what a document holds is what a
 * template holds, and what a template holds is what stands up on another
 * timeline. Losing a grade, a key, a bar, or a sticker on the way through
 * would make a replicate a different video.
 */

const asset = (id: string, type: MediaAsset["type"], duration: number): MediaAsset => ({
  id,
  fileName: `${id}.bin`,
  name: id,
  type,
  duration,
  url: "",
});

describe("templateFromDoc", () => {
  test("the whole edit keeps every treatment, bar, sticker and font", () => {
    const { template: t, assetByMedia, sourceAssets } = templateFromDoc(richDoc());
    expect([...assetByMedia].sort()).toEqual(["f0", "m0", "s0", "v0", "v1"]);
    expect(sourceAssets.map((a) => a.fileName).sort()).toEqual(["arrow.png", "brand.ttf", "clip-0.mp4", "clip-1.mp4", "music.m4a"]);
    const [l0, l1, l2] = t.layers;
    expect(l0).toMatchObject({ media: 0, start: 0, asClip: true, track: 1, speed: 1.25, volume: 0.8, fit: "fill", zoom: 1.4 });
    expect(t.texts.find((o) => o.id === "e0")).toMatchObject({ kind: "effect", effect: "vintage", amount: 0.6 });
    expect(l1).toMatchObject({ media: 1, asClip: true, mask: { kind: "circle", w: 0.7, h: 0.7, feather: 20 } });
    expect(l1.grade).toEqual({ brightness: 5, contrast: 8, saturation: -10, temperature: 12, hue: 10 });
    expect(l1.kf).toHaveLength(2);
    expect(l2).toMatchObject({ media: 0, track: 2, boxStyle: { radius: 24, borderWidth: 4, borderColor: "#ffffff" }, rotation: 5, opacity: 0.9 });
    expect(l2.asClip).toBeUndefined();
    expect(t.audio[0]).toMatchObject({ media: 2, volume: 0.5, fadeIn: 0.3, fadeOut: 0.5, duck: 0.4 });
    // The head fade, the cut, and the tail zoom: every edge is a bar.
    expect(t.transitions!.map((b) => b.id)).toEqual(["tr-in", "tr0", "tr-out"]);
    expect(t.transitions![1]).toMatchObject({ seconds: 0.5, style: "crossfade" });
    expect(t.stickers).toEqual([{ text: t.texts.findIndex((o) => o.id === "s1"), media: assetByMedia.indexOf("s0") }]);
    expect(t.texts).toHaveLength(4);
    expect(t.cues).toHaveLength(2);
    expect(t.captions).toEqual({ showOnVideo: true, style: "bubble", size: 60, wordsPerCue: 3, wordHighlight: true, accentColor: "#FF3366", x: 0.5, y: 0.85 });
    expect(t.project).toEqual({ aspect: "16:9", background: "#102030", fadeIn: 0.3, fadeOut: 0.4 });
    expect(t.duration).toBeCloseTo(RICH_CLIP_S / 1.25 + RICH_CLIP_S, 5);
  });

  test("items pick a subset, timed from the earliest, with the bars playing on a chosen clip", () => {
    const { template: t, assetByMedia, unknownItems } = templateFromDoc(richDoc(), { items: ["c1", "t1"] });
    expect(unknownItems).toEqual([]);
    const c0Len = RICH_CLIP_S / 1.25;
    // The title at 3s is the earliest chosen item, so everything is timed from it.
    expect(t.layers).toHaveLength(1);
    expect(t.layers[0].start).toBeCloseTo(c0Len - 3, 5);
    expect(t.texts).toHaveLength(1);
    expect((t.texts[0] as { start: number }).start).toBeCloseTo(0, 5);
    // Only the bar on the chosen clip's own edge: the cut bar plays c0's tail.
    expect(t.transitions!.map((b) => b.id)).toEqual(["tr-out"]);
    expect(t.transitions![0].start).toBeCloseTo(c0Len + RICH_CLIP_S - 0.5 - 3, 5);
    expect(t.audio).toHaveLength(0);
    expect(t.cues).toHaveLength(0);
    // Only the media the chosen items use: c1's footage and t1's font.
    expect([...assetByMedia].sort()).toEqual(["f0", "v1"]);
  });

  test("an id the document lacks is reported", () => {
    expect(templateFromDoc(richDoc(), { items: ["c1", "nope"] }).unknownItems).toEqual(["nope"]);
  });
});

describe("clampLayersToAssets", () => {
  const base = (): TemplateSaveInput => ({
    name: "t",
    duration: 10,
    media: [
      { fileName: "a", name: "a", type: "video", duration: 10 },
      { fileName: "b", name: "b", type: "audio", duration: 10 },
    ],
    layers: [{ media: 0, start: 0, in: 2, out: 9, muted: false, track: 1, asClip: true, speedCurve: [[0, 1], [4, 2], [8, 1]] }],
    audio: [{ media: 1, start: 0, in: 0, out: 9, volume: 1 }],
    texts: [],
    cues: [],
  });

  test("a shorter source ends the trim where it ends and drops curve nodes past it", () => {
    const { template, adjustments } = clampLayersToAssets(base(), ["x", "y"], [asset("x", "video", 5), asset("y", "audio", 4)]);
    expect(template.layers[0]).toMatchObject({ in: 2, out: 5, speedCurve: [[0, 1], [4, 2]] });
    expect(template.audio[0]).toMatchObject({ in: 0, out: 4 });
    expect(adjustments.map((a) => `${a.item}.${a.field}`)).toEqual(["layer 0.out", "layer 0.speedCurve", "audio 0.out"]);
  });

  test("a trim starting past the source's end pulls in behind out", () => {
    const { template, adjustments } = clampLayersToAssets(base(), ["x", "y"], [asset("x", "video", 1), asset("y", "audio", 10)]);
    expect(template.layers[0].out).toBe(1);
    expect(template.layers[0].in).toBeCloseTo(0.9, 5);
    expect(adjustments.some((a) => a.field === "in")).toBe(true);
  });

  test("a still plays the clip's placed length with no rate", () => {
    const t = base();
    t.layers[0] = { ...t.layers[0], speedCurve: undefined, speed: 2 };
    const { template, adjustments } = clampLayersToAssets(t, ["x", "y"], [asset("x", "image", 0), asset("y", "audio", 10)]);
    expect(template.layers[0]).toMatchObject({ in: 0, out: 3.5 });
    expect(template.layers[0].speed).toBeUndefined();
    expect(adjustments[0].item).toBe("layer 0");
  });

  test("an unmapped entry is left alone", () => {
    const { template, adjustments } = clampLayersToAssets(base(), ["", ""], []);
    expect(template.layers[0].out).toBe(9);
    expect(adjustments).toEqual([]);
  });
});

describe("insertTemplate", () => {
  beforeEach(() => {
    useEditor.setState({
      projectId: "p2",
      clips: [],
      transitions: [],
      audioClips: [],
      overlays: [],
      assets: [asset("b0", "video", 30), asset("b1", "video", 30), asset("bm", "audio", 60), asset("bs", "image", 0)],
      subtitles: emptySubtitles(),
      selection: null,
      multiSelection: [],
    });
  });

  // v0→b0, v1→b1, m0→bm, s0→bs; the font is unmapped and never placed.
  const MAP: Record<string, string> = { v0: "b0", v1: "b1", m0: "bm", s0: "bs", f0: "" };
  const idsFor = (assetByMedia: string[], map = MAP) => assetByMedia.map((id) => map[id] ?? "");

  test("stands the whole edit up on other footage, treatment and all", () => {
    const { template, assetByMedia } = templateFromDoc(richDoc());
    useEditor.getState().insertTemplate({ ...template, id: "t", addedAt: 0 }, idsFor(assetByMedia), 0);
    const s = useEditor.getState();
    const track0 = s.clips.filter((c) => c.track === 0).sort((a, b) => a.start - b.start);
    expect(track0).toHaveLength(2);
    expect(track0[0]).toMatchObject({ assetId: "b0", speed: 1.25, volume: 0.8, animIn: { style: "fade", seconds: 0.4 } });
    expect(track0[1]).toMatchObject({ assetId: "b1", mask: { kind: "circle", w: 0.7, h: 0.7, feather: 20 }, animOut: { style: "zoom", seconds: 0.5 } });
    expect(track0[1].grade).toEqual({ brightness: 5, contrast: 8, saturation: -10, temperature: 12, hue: 10 });
    expect(track0[1].kf).toHaveLength(2);
    const layer = s.clips.find((c) => c.track !== 0)!;
    // The reference's track-1 layer lands on track 1 of an empty project.
    expect(layer).toMatchObject({ track: 1, assetId: "b0", boxStyle: { radius: 24 }, rotation: 5, opacity: 0.9 });
    expect(s.audioClips[0]).toMatchObject({ assetId: "bm", volume: 0.5, fadeIn: 0.3, fadeOut: 0.5, duck: 0.4 });
    // Every bar lands on the edge it was saved on, and the clips read their
    // edges back from the bars.
    expect(s.transitions).toHaveLength(3);
    const roles = resolveTransitions(s.clips, s.transitions);
    for (const bar of s.transitions) expect((roles.get(bar.id) ?? []).length).toBeGreaterThan(0);
    // Texts keep their keys and group as one new group; the sticker points at the copy.
    const texts = s.overlays.filter(isTextOverlay);
    expect(texts).toHaveLength(2);
    expect(texts[0].kf).toHaveLength(2);
    expect(texts[0].groupId).toBeDefined();
    expect(texts[0].groupId).toBe(texts[1].groupId);
    expect(texts[0].groupId).not.toBe("g1");
    const sticker = s.overlays.find(isStickerOverlay)!;
    expect(sticker.assetId).toBe("bs");
    // Two titles, the sticker, and the look.
    expect(s.overlays).toHaveLength(4);
    expect(s.subtitles.cues).toHaveLength(2);
  });

  test("a sticker whose media is unmapped stays out, like a layer", () => {
    const { template, assetByMedia } = templateFromDoc(richDoc());
    useEditor.getState().insertTemplate({ ...template, id: "t", addedAt: 0 }, idsFor(assetByMedia, { ...MAP, s0: "" }), 0);
    expect(useEditor.getState().overlays.some(isStickerOverlay)).toBe(false);
    expect(useEditor.getState().overlays).toHaveLength(3);
  });

  test("a dropped sticker leaves the stickers after it on their own media", () => {
    const { template, assetByMedia } = templateFromDoc(richDoc());
    // Two stickers, one before the titles and one after; the first's media is unmapped.
    const s1 = template.texts.find((o) => o.id === "s1")!;
    const early = { ...s1, id: "s-early", start: 0, end: 1 };
    const texts = [early, ...template.texts.filter((o) => o.id !== "s1"), s1];
    const media = [...template.media, { ...template.media[assetByMedia.indexOf("s0")] }];
    const stickers = [
      { text: 0, media: media.length - 1 },
      { text: texts.length - 1, media: assetByMedia.indexOf("s0") },
    ];
    const ids = [...idsFor(assetByMedia), ""];
    useEditor.getState().insertTemplate({ ...template, texts, media, stickers, id: "t", addedAt: 0 }, ids, 0);
    const overlays = useEditor.getState().overlays;
    expect(overlays.filter(isStickerOverlay)).toHaveLength(1);
    expect(overlays.find(isStickerOverlay)!.assetId).toBe("bs");
    expect(overlays.filter(isTextOverlay).every((o) => !("assetId" in o))).toBe(true);
  });

  test("cue word timings move with the cue, out of the reference and onto the timeline", () => {
    const doc = richDoc();
    doc.subtitles!.cues[0].words = [
      { t0: 0.3, t1: 0.7, w: "every" },
      { t0: 0.8, t1: 1.2, w: "feature" },
    ];
    const { template, assetByMedia } = templateFromDoc(doc, { items: ["q0"] });
    // Timed from the cue itself, so it starts the template at 0.
    const words = template.cues[0].words!;
    expect(words.map((w) => w.w)).toEqual(["every", "feature"]);
    expect(words[0].t0).toBeCloseTo(0, 5);
    expect(words[0].t1).toBeCloseTo(0.4, 5);
    expect(words[1].t0).toBeCloseTo(0.5, 5);
    expect(words[1].t1).toBeCloseTo(0.9, 5);
    useEditor.getState().insertTemplate({ ...template, id: "t", addedAt: 0 }, idsFor(assetByMedia), 4);
    const cue = useEditor.getState().subtitles.cues[0];
    expect(cue.start).toBeCloseTo(4, 5);
    expect(cue.words![0].t0).toBeCloseTo(4, 5);
    expect(cue.words![1].t1).toBeCloseTo(4.9, 5);
  });

  test("a template saved before the rail carried treatments inserts as before", () => {
    const old = {
      id: "old",
      name: "old",
      addedAt: 0,
      duration: 4,
      media: [{ fileName: "x", name: "x", type: "video" as const, duration: 10 }],
      layers: [{ media: 0, start: 0, in: 0, out: 4, muted: false, track: 1, asClip: true }],
      audio: [],
      texts: [],
      cues: [],
    };
    useEditor.getState().insertTemplate(old, ["b0"], 0);
    const c = useEditor.getState().clips[0];
    expect(c).toMatchObject({ assetId: "b0", track: 0, start: 0, in: 0, out: 4 });
    expect(c.grade).toBeUndefined();
    expect(useEditor.getState().transitions).toHaveLength(0);
  });

  test("layers stack above a project's existing layers", () => {
    useEditor.setState({
      clips: [
        { id: "spine", assetId: "b1", track: 0, start: 0, in: 0, out: 3, muted: false },
        { id: "have", assetId: "b1", track: 1, start: 0, in: 0, out: 3, muted: true },
      ],
    });
    const { template, assetByMedia } = templateFromDoc(richDoc());
    useEditor.getState().insertTemplate({ ...template, id: "t", addedAt: 0 }, idsFor(assetByMedia), 0);
    const layers = useEditor.getState().clips.filter((c) => c.track !== 0 && c.id !== "have");
    expect(layers.map((c) => c.track)).toEqual([2]);
  });
});

describe("selectionTemplate", () => {
  test("carries the clip's treatment, the bar on it, and a sticker's media", async () => {
    const doc = richDoc();
    const assets: MediaAsset[] = doc.assets.map((a) => ({ ...a, url: "" }));
    await useEditor.getState().openProjectDoc("rich", doc, assets);
    const s = useEditor.getState();
    s.select({ kind: "clip", id: "c0" });
    s.toggleSelect({ kind: "clip", id: "c1" });
    s.toggleSelect({ kind: "overlay", id: "s1" });
    const t = useEditor.getState().selectionTemplate()!;
    expect(t.layers[0]).toMatchObject({ speed: 1.25, volume: 0.8 });
    expect(t.layers[1].grade).toBeDefined();
    expect(t.layers[1].kf).toHaveLength(2);
    expect(t.transitions).toHaveLength(3);
    expect(t.stickers).toEqual([{ text: 0, media: 2 }]);
    expect(t.media.map((m) => m.fileName)).toEqual(["clip-0.mp4", "clip-1.mp4", "arrow.png"]);
  });
});
