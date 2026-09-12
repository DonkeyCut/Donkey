// A stored project document as a template: the whole edit, or the items a
// caller picked out of it, in the shape the Library template rail already
// stands up. This is what lets one project's cut be rebuilt in another on
// different footage — the document is the edit, and the template is the
// document with its media held by index so a caller can say which asset
// plays each part.

import { ITEM_KINDS, type ItemKind, type ItemOf } from "./itemKinds";
import { getClipSpans, layerFromClip, normalizeDocState, resolveTransitions, totalDuration } from "./store";
import {
  CAPTION_LOOK_KEYS,
  fontAssetId,
  isStickerOverlay,
  type AssetType,
  type MediaAsset,
  type ProjectDoc,
  type StoredAsset,
  type TemplateAudio,
  type TemplateLayer,
  type TemplateMedia,
  type TemplateSaveInput,
} from "./types";

export interface DocTemplate {
  template: TemplateSaveInput;
  /** The source asset id behind each `template.media` entry. */
  assetByMedia: string[];
  /** The source assets behind each media entry, whole, so a copy keeps the
   * notes, transcript and beats written against them. */
  sourceAssets: StoredAsset[];
  /** Ids asked for that the document does not hold. */
  unknownItems: string[];
  /** The source clip id behind each template layer, and behind each
   * soundtrack clip, so an adjustment can name the item it moved. */
  itemByLayer: string[];
  itemByAudio: string[];
}

/** The document's edit as a template. With `items`, only those timeline
 * items (clips on any track, soundtrack clips, elements, cues, transition
 * bars) come along, timed from the earliest of them; without, the whole cut
 * from 0. Transition bars playing on a chosen clip travel with it. */
export function templateFromDoc(doc: ProjectDoc, opts: { items?: string[] } = {}): DocTemplate {
  const assets: MediaAsset[] = (doc.assets ?? []).map((a) => ({ ...a, url: "" }));
  const state = normalizeDocState(doc, assets);
  const pick = opts.items ? new Set(opts.items) : null;
  const wanted = (id: string) => !pick || pick.has(id);

  const clips = state.clips.filter((c) => wanted(c.id));
  const audioClips = state.audioClips.filter((c) => wanted(c.id));
  const overlays = state.overlays.filter((o) => wanted(o.id));
  const cues = state.subtitles.cues.filter((c) => wanted(c.id));
  const clipIds = new Set(clips.map((c) => c.id));
  const roles = resolveTransitions(state.clips, state.transitions);
  const transitions = state.transitions.filter(
    (t) => wanted(t.id) || (pick !== null && (roles.get(t.id) ?? []).some((rl) => clipIds.has(rl.clipId)))
  );

  const found = new Set([
    ...clips.map((c) => c.id),
    ...audioClips.map((c) => c.id),
    ...overlays.map((o) => o.id),
    ...cues.map((c) => c.id),
    ...transitions.map((t) => t.id),
  ]);
  const unknownItems = pick ? [...pick].filter((id) => !found.has(id)) : [];

  const starts = [
    ...clips.map((c) => c.start),
    ...audioClips.map((c) => c.start),
    ...overlays.map((o) => o.start),
    ...cues.map((c) => c.start),
    ...transitions.map((t) => t.start),
  ];
  const start0 = pick && starts.length ? Math.min(...starts) : 0;

  const media: TemplateMedia[] = [];
  const assetByMedia: string[] = [];
  const sourceAssets: StoredAsset[] = [];
  const indexByAsset = new Map<string, number>();
  const mediaFor = (assetId: string): number | null => {
    const cached = indexByAsset.get(assetId);
    if (cached != null) return cached;
    const a = (doc.assets ?? []).find((x) => x.id === assetId);
    if (!a) return null;
    const i = media.length;
    media.push({ fileName: a.fileName, name: a.name, type: a.type, duration: a.duration, width: a.width, height: a.height });
    assetByMedia.push(a.id);
    sourceAssets.push(a);
    indexByAsset.set(assetId, i);
    return i;
  };

  // What each item names once it leaves its project: the media it plays and
  // the font it is set in join the template's media; a background removal
  // stays behind with the footage its matte was baked from.
  const across = <K extends ItemKind>(kind: K, item: ItemOf[K]): ItemOf[K] => ITEM_KINDS[kind].crossProject(item);
  const spans = getClipSpans(state.clips, assets);
  const layers: TemplateLayer[] = [];
  const itemByLayer: string[] = [];
  for (const raw of clips) {
    const c = across("clip", raw);
    const mi = mediaFor(c.assetId);
    if (mi == null) continue;
    const sp = spans.find((x) => x.clip.id === c.id);
    layers.push(layerFromClip(c, start0, mi, sp ? sp.start : c.start));
    itemByLayer.push(c.id);
  }
  const audio: TemplateAudio[] = [];
  const itemByAudio: string[] = [];
  for (const c of audioClips) {
    const mi = mediaFor(c.assetId);
    if (mi == null) continue;
    audio.push({ media: mi, start: c.start - start0, in: c.in, out: c.out, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut, speed: c.speed, speedCurve: c.speedCurve, reverse: c.reverse, sound: c.sound, duck: c.duck, lane: c.lane });
    itemByAudio.push(c.id);
  }
  const texts: TemplateSaveInput["texts"] = [];
  const stickers: { text: number; media: number }[] = [];
  for (const raw of overlays) {
    const o = across("overlay", raw);
    if (isStickerOverlay(o) && o.assetId) {
      const mi = mediaFor(o.assetId);
      if (mi == null) continue;
      stickers.push({ text: texts.length, media: mi });
    }
    // Everything else the element names — a title's uploaded font — brings
    // its file along; the element itself keeps the id, which the insert
    // remaps by asset.
    for (const id of ITEM_KINDS.overlay.assetIds(o)) mediaFor(id);
    texts.push({ ...o, start: o.start - start0, end: o.end - start0 });
  }

  const captions: TemplateSaveInput["captions"] = {};
  for (const k of CAPTION_LOOK_KEYS) {
    const v = state.subtitles[k];
    if (v !== undefined) (captions as Record<string, unknown>)[k] = v;
  }
  const captionFont = state.subtitles.font ? fontAssetId(state.subtitles.font) : null;
  if (captionFont) mediaFor(captionFont);

  const ends = [
    ...layers.map((l) => l.start + (l.out - l.in) / (l.speed ?? 1)),
    ...audio.map((a) => a.start + (a.out - a.in) / (a.speed ?? 1)),
    ...texts.map((t) => t.end),
    ...cues.map((c) => c.end - start0),
  ];
  const duration = pick ? Math.max(0.1, ...ends) : Math.max(totalDuration(state.clips), 0.1, ...ends);

  return {
    template: {
      name: doc.name ?? "Project",
      duration,
      media,
      layers,
      audio,
      texts,
      cues: cues.map((c) => ({
        ...c,
        start: c.start - start0,
        end: c.end - start0,
        ...(c.words ? { words: c.words.map((w) => ({ ...w, t0: w.t0 - start0, t1: w.t1 - start0 })) } : {}),
      })),
      ...(stickers.length ? { stickers } : {}),
      ...(transitions.length
        ? { transitions: transitions.map((t) => ({ ...t, start: t.start - start0 })) }
        : {}),
      captions,
      project: {
        aspect: state.aspect ?? "9:16",
        background: state.background,
        fadeIn: state.fadeIn,
        fadeOut: state.fadeOut,
      },
    },
    assetByMedia,
    sourceAssets,
    unknownItems,
    itemByLayer,
    itemByAudio,
  };
}

export interface TemplateAdjustment {
  /** Which part moved: the caller's label for it, `layer N` or `audio N` by
   * index in the template when none was given. */
  item: string;
  field: string;
  from: number;
  to: number;
  reason: string;
}

/** The template with every trim held inside the asset that will play it.
 * A layer mapped onto a shorter source ends where the source ends; one mapped
 * onto a still keeps its placed length and drops its rate; speed-curve nodes
 * past the source's end go. Every change is listed, so whoever asked can
 * fix or report it. */
export function clampLayersToAssets(
  template: TemplateSaveInput,
  assetIds: string[],
  assets: Pick<StoredAsset, "id" | "type" | "duration">[],
  labels: { layers?: string[]; audio?: string[] } = {}
): { template: TemplateSaveInput; adjustments: TemplateAdjustment[] } {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const adjustments: TemplateAdjustment[] = [];
  const MIN = 0.1;
  const clampTrim = <T extends { in: number; out: number; speedCurve?: [number, number][] }>(
    item: T,
    label: string,
    duration: number
  ): T => {
    let { in: i, out } = item;
    if (out > duration + 1e-6) {
      adjustments.push({ item: label, field: "out", from: out, to: duration, reason: "the mapped source is shorter" });
      out = duration;
    }
    if (i > out - MIN) {
      const to = Math.max(0, out - MIN);
      adjustments.push({ item: label, field: "in", from: i, to, reason: "the trim started past the mapped source's end" });
      i = to;
    }
    const nodes = item.speedCurve?.filter((n) => n[0] <= duration);
    const dropped = (item.speedCurve?.length ?? 0) - (nodes?.length ?? 0);
    if (dropped > 0)
      adjustments.push({ item: label, field: "speedCurve", from: item.speedCurve!.length, to: nodes!.length, reason: "nodes past the mapped source's end dropped" });
    return {
      ...item,
      in: i,
      out,
      ...(item.speedCurve ? { speedCurve: nodes && nodes.length >= 2 ? nodes : undefined } : {}),
    };
  };
  const layers = template.layers.map((l, n) => {
    const a = byId.get(assetIds[l.media]);
    if (!a) return l;
    const label = labels.layers?.[n] ?? `layer ${n}`;
    if (a.type === "image") {
      const placed = (l.out - l.in) / (l.speed ?? 1);
      if (l.in !== 0 || l.speed || l.speedCurve || l.reverse || l.smoothSlow) {
        adjustments.push({ item: label, field: "out", from: l.out, to: placed, reason: "a still plays the clip's placed length with no rate" });
      }
      const still: TemplateLayer = { ...l, in: 0, out: placed };
      delete still.speed;
      delete still.speedCurve;
      delete still.reverse;
      delete still.smoothSlow;
      return still;
    }
    return clampTrim(l, label, a.duration);
  });
  const audio = template.audio.map((c, n) => {
    const a = byId.get(assetIds[c.media]);
    if (!a) return c;
    return clampTrim(c, labels.audio?.[n] ?? `audio ${n}`, a.duration);
  });
  return { template: { ...template, layers, audio }, adjustments };
}

/** Whether an asset of this type can stand in for a source of that type. */
export const mediaTypeFits = (source: AssetType, replacement: AssetType): boolean =>
  source === "audio" || source === "font"
    ? replacement === source
    : replacement === "video" || replacement === "image";
