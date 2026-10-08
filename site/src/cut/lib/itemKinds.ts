// The timeline's item kinds, in one table.
//
// Every kind of thing a person can select on the timeline — a clip, a
// soundtrack clip, an element, a caption cue, a transition bar — is one entry
// here, and the entry says what the editor needs to know about it to move it
// around: where it lives, which assets it plays, how to point it at other
// assets, and what it sheds when it leaves its project. The clipboard, the
// cross-project paste, the template rail and the media garbage collector all
// read this table, so an item kind is copyable, pasteable, templatable and
// GC-safe by construction.
//
// The table is typed against `Selection`, so adding a kind there fails to
// compile until it has an entry, and `itemKinds.test.ts` walks the table so
// every entry proves it copies and pastes.

import { KEY_EPSILON, maskKeyAt, OVERLAY_HIT_DEFAULT_SECONDS, poseAt, retimeOf, shiftCamera, sortedKeys, type EaseId, type Mask, type OverlayAnim, type OverlayKey, type OverlayPose } from "@donkeycut/effects-kit";
import { splitEmphasis, withEmphasis } from "./captionEmphasis";
import {
  clipPoseAt,
  fontAssetId,
  isStickerOverlay,
  isTextOverlay,
  uploadedFontId,
  type AudioClip,
  type Overlay,
  type Selection,
  type SubtitleCue,
  type TimelineTransition,
  type VideoClip,
} from "./types";

export type ItemKind = NonNullable<Selection>["kind"];

/** The item type behind each kind. */
export interface ItemOf {
  clip: VideoClip;
  audio: AudioClip;
  overlay: Overlay;
  cue: SubtitleCue;
  transition: TimelineTransition;
}

/** One item as the clipboard holds it: the item whole, ids and all, so a
 * paste can remap what it must and keep the rest. */
export type TimelineClipboardItem = { [K in ItemKind]: { kind: K; item: ItemOf[K] } }[ItemKind];

/** The lists the items live in, as the store and a document both hold them. */
export interface ItemLists {
  clips: VideoClip[];
  audioClips: AudioClip[];
  overlays: Overlay[];
  transitions: TimelineTransition[];
  subtitles: { cues: SubtitleCue[] };
}

export interface ItemKindDef<K extends ItemKind> {
  /** Items can move between rows or open a row between existing ones. */
  multiLane?: boolean;
  /** The list this kind lives in. */
  list(s: ItemLists): ItemOf[K][];
  /** Store the list while preserving the document's other collections. */
  withList(s: ItemLists, items: ItemOf[K][]): ItemLists;
  /** Timeline duration and row, independent of the item's source representation. */
  duration(item: ItemOf[K]): number;
  lane(item: ItemOf[K]): number;
  /** Move to a timeline start, preserving all item properties and local timing. */
  at(item: ItemOf[K], start: number): ItemOf[K];
  /** Split at an interior timeline time; the coordinator assigns the new id. */
  split: ((item: ItemOf[K], at: number) => [ItemOf[K], ItemOf[K]]) | null;
  /** A copy that shares nothing with the original. */
  clone(item: ItemOf[K]): ItemOf[K];
  /** Every asset id on the item: the media it plays, the font it is set in,
   * the mattes baked for it. The one place that knows where ids sit. */
  assetIds(item: ItemOf[K]): string[];
  /** The item with every asset id rewritten through `to`. */
  remapAssets(item: ItemOf[K], to: (id: string) => string): ItemOf[K];
  /** The item as it leaves its project: parts baked against that project's
   * media stay behind. */
  crossProject(item: ItemOf[K]): ItemOf[K];
}

const deep = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** How finely an eased move cut in two is redrawn as straight steps. */
const SPLIT_EASE_STEP = 1 / 30;

/** A key track cut at `cut` seconds into its item. Each half keeps the keys on
 * its side, closed by a key holding the value at the cut, and the right
 * half's keys count from its own start — so both halves play what the whole
 * did. A tracked mask keys every frame, and a split copy has to hold it. An
 * eased move the cut lands in has no named curve for either part, so it is
 * redrawn as straight steps along the original curve. */
function splitKeys<K extends { t: number; ease?: EaseId }>(
  keys: K[] | undefined,
  cut: number,
  valueAt: (t: number) => K
): [K[] | undefined, K[] | undefined] {
  if (!keys || keys.length === 0) return [keys, keys];
  const sorted = sortedKeys(keys);

  // The eased move under the cut, as plain keys every step along its curve.
  // Example: a sine.inOut move from 0s to 4s cut at 1s plays the same curve
  // through 0–1s on the left and 1–4s on the right.
  const i = sorted.findIndex((k, n) => k.t < cut - KEY_EPSILON && sorted[n + 1]?.t > cut + KEY_EPSILON);
  const eased = i >= 0 && sorted[i].ease ? sorted[i] : null;
  const steps = eased ? Math.ceil((sorted[i + 1].t - eased.t) / SPLIT_EASE_STEP) : 0;
  const along = Array.from({ length: Math.max(0, steps - 1) }, (_, n) => {
    const t = eased!.t + ((n + 1) * (sorted[i + 1].t - eased!.t)) / steps;
    return { ...valueAt(t), t, ease: undefined };
  });
  const plain = sorted.map((k) => (k === eased ? { ...k, ease: undefined } : k));
  const all = [...plain, ...along].sort((a, b) => a.t - b.t);

  const edge = { ...valueAt(cut), ease: undefined };
  return [
    [...all.filter((k) => k.t < cut - KEY_EPSILON), { ...edge, t: cut }],
    [{ ...edge, t: 0 }, ...all.filter((k) => k.t > cut + KEY_EPSILON).map((k) => ({ ...k, t: k.t - cut }))],
  ];
}

/** An item's pose and mask tracks cut at `cut` seconds into it, as the
 * fields each half takes. */
function splitTracks(
  item: { kf?: OverlayKey[]; mask?: Mask },
  cut: number,
  poseOf: (t: number) => OverlayPose
): [{ kf?: OverlayKey[]; mask?: Mask }, { kf?: OverlayKey[]; mask?: Mask }] {
  const [kfL, kfR] = splitKeys(item.kf, cut, (t) => ({ t, ...poseOf(t) }));
  const m = item.mask;
  const [mL, mR] = splitKeys(m?.kf, cut, (t) => maskKeyAt(m!, t));
  return [
    { ...(item.kf ? { kf: kfL } : {}), ...(m ? { mask: { ...m, kf: mL } } : {}) },
    { ...(item.kf ? { kf: kfR } : {}), ...(m ? { mask: { ...m, kf: mR } } : {}) },
  ];
}

/** An element's press cut at `cut` seconds into it: each half keeps it
 * while its window reaches that half, the right half counting from its own
 * start, so the press lands where it did on the timeline. */
function splitHit(anim: OverlayAnim | undefined, cut: number): [OverlayAnim | undefined, OverlayAnim | undefined] {
  const hit = anim?.hit;
  if (!hit) return [anim, anim];
  const { hit: _drop, ...rest } = anim;
  void _drop;
  return [
    hit.at < cut ? anim : rest,
    hit.at + (hit.seconds > 0 ? hit.seconds : OVERLAY_HIT_DEFAULT_SECONDS) > cut ? { ...rest, hit: { ...hit, at: hit.at - cut } } : rest,
  ];
}

function splitMedia<T extends VideoClip | AudioClip>(item: T, at: number): [T, T] {
  const cut = retimeOf(item).srcAt(at - item.start);
  return item.reverse
    ? [{ ...item, in: cut }, { ...item, start: at, out: cut }]
    : [{ ...item, out: cut }, { ...item, start: at, in: cut }];
}

export const ITEM_KINDS: { [K in ItemKind]: ItemKindDef<K> } = {
  clip: {
    multiLane: true,
    list: (s) => s.clips,
    withList: (s, clips) => ({ ...s, clips }),
    duration: (c) => retimeOf(c).len,
    lane: (c) => c.track,
    at: (c, start) => ({ ...c, start }),
    split: (c, at) => {
      const [left, right] = splitMedia(c, at);
      const [keysL, keysR] = splitTracks(c, at - c.start, (t) => clipPoseAt(c, t));
      // A split edit stays on the outer edges: the new cut between the halves
      // carries none.
      // The right half's effects carry on from where the cut leaves them.
      const effectsR = c.effects?.length ? { effectsFrom: (c.effectsFrom ?? 0) + (at - c.start) } : {};
      return [
        { ...left, ...keysL, transition: undefined, transitionStyle: undefined, animOut: undefined, audioTail: undefined },
        { ...right, ...keysR, ...effectsR, animIn: undefined, audioLead: undefined },
      ];
    },
    clone: deep,
    assetIds: (c) =>
      [c.assetId, c.removal?.matte?.assetId, c.removal?.backdrop?.assetId, c.card?.matte?.assetId].filter(
        (id): id is string => typeof id === "string" && id.length > 0
      ),
    remapAssets: (c, to) => ({
      ...c,
      assetId: to(c.assetId),
      ...(c.removal
        ? {
            removal: {
              ...c.removal,
              ...(c.removal.matte?.assetId ? { matte: { ...c.removal.matte, assetId: to(c.removal.matte.assetId) } } : {}),
              ...(c.removal.backdrop?.assetId
                ? { backdrop: { ...c.removal.backdrop, assetId: to(c.removal.backdrop.assetId) } }
                : {}),
            },
          }
        : {}),
      ...(c.card?.matte?.assetId ? { card: { ...c.card, matte: { ...c.card.matte, assetId: to(c.card.matte.assetId) } } } : {}),
    }),
    // A background removal's matte was baked from this project's footage,
    // and a clip arriving with a removal and no matte would start a fresh
    // bake on its own. A camera card keeps its layout and bakes its own
    // person matte where it lands.
    crossProject: (c) => {
      const out = { ...c };
      delete out.removal;
      if (out.card) out.card = { ...out.card, matte: undefined };
      return out;
    },
  },
  audio: {
    multiLane: true,
    list: (s) => s.audioClips,
    withList: (s, audioClips) => ({ ...s, audioClips }),
    duration: (a) => retimeOf(a).len,
    lane: (a) => a.lane ?? 0,
    at: (a, start) => ({ ...a, start }),
    split: splitMedia,
    clone: deep,
    assetIds: (a) => (a.assetId ? [a.assetId] : []),
    remapAssets: (a, to) => ({ ...a, assetId: to(a.assetId) }),
    crossProject: (a) => a,
  },
  overlay: {
    multiLane: true,
    list: (s) => s.overlays,
    withList: (s, overlays) => ({ ...s, overlays }),
    duration: (o) => o.end - o.start,
    lane: (o) => o.lane ?? 0,
    at: (o, start) => ({ ...o, start, end: start + o.end - o.start }),
    // The tail keeps filming on the group camera's clock.
    split: (o, at) => {
      const [keysL, keysR] = splitTracks(o, at - o.start, (t) => poseAt(o, t));
      const [animL, animR] = splitHit(o.anim, at - o.start);
      return [
        { ...o, ...keysL, anim: animL, end: at },
        { ...o, ...keysR, anim: animR, start: at, ...(o.camera ? { camera: shiftCamera(o.camera, o.start - at) } : {}) },
      ];
    },
    clone: deep,
    assetIds: (o) => {
      if (isStickerOverlay(o)) return o.assetId ? [o.assetId] : [];
      if (isTextOverlay(o)) {
        const font = o.font ? fontAssetId(o.font) : null;
        return font ? [font] : [];
      }
      return [];
    },
    remapAssets: (o, to) => {
      if (isStickerOverlay(o)) return o.assetId ? { ...o, assetId: to(o.assetId) } : o;
      if (isTextOverlay(o)) {
        const font = o.font ? fontAssetId(o.font) : null;
        return font ? { ...o, font: uploadedFontId(to(font)) } : o;
      }
      return o;
    },
    crossProject: (o) => o,
  },
  cue: {
    list: (s) => s.subtitles.cues,
    withList: (s, cues) => ({ ...s, subtitles: { ...s.subtitles, cues } }),
    duration: (c) => c.end - c.start,
    lane: (c) => c.lane ?? 0,
    at: (c, start) => ({ ...c, start, end: start + c.end - c.start,
      ...(c.words ? { words: c.words.map((w) => ({ ...w, t0: w.t0 + start - c.start, t1: w.t1 + start - c.start })) } : {}),
    }),
    split: (c, at) => {
      const left = c.words?.filter((w) => w.t0 < at);
      const right = c.words?.filter((w) => w.t0 >= at);
      const offset = Math.round(c.text.length * ((at - c.start) / (c.end - c.start)));
      const leftText = left?.length ? left.map((w) => w.w).join(" ") : c.text.slice(0, offset).trim() || c.text;
      const rightText = right?.length ? right.map((w) => w.w).join(" ") : c.text.slice(offset).trim() || c.text;
      // Each half keeps the emphasis of the words it took.
      const [leftMarks, rightMarks] = splitEmphasis(c, leftText, rightText);
      return [
        withEmphasis({ ...c, end: at, text: leftText, words: left?.length ? left : undefined }, leftMarks),
        withEmphasis({ ...c, start: at, text: rightText, words: right?.length ? right : undefined }, rightMarks),
      ];
    },
    clone: deep,
    assetIds: () => [],
    remapAssets: (c) => c,
    crossProject: (c) => c,
  },
  transition: {
    list: (s) => s.transitions,
    withList: (s, transitions) => ({ ...s, transitions }),
    duration: (t) => t.seconds,
    lane: () => 0,
    at: (t, start) => ({ ...t, start }),
    split: null,
    clone: deep,
    assetIds: () => [],
    remapAssets: (t) => t,
    crossProject: (t) => t,
  },
};

export const ITEM_KIND_IDS = Object.keys(ITEM_KINDS) as ItemKind[];
export const ROW_ITEM_KINDS = ITEM_KIND_IDS.filter((kind) => ITEM_KINDS[kind].multiLane);

/** The item a selection names, as a clipboard item, or null when gone. */
export function clipboardItemFor(s: ItemLists, sel: NonNullable<Selection>): TimelineClipboardItem | null {
  const def = ITEM_KINDS[sel.kind] as ItemKindDef<ItemKind>;
  const item = (def.list(s) as { id: string }[]).find((x) => x.id === sel.id);
  return item ? ({ kind: sel.kind, item: def.clone(item as never) } as TimelineClipboardItem) : null;
}

/** Every asset id a clipboard item names. */
export const clipboardItemAssetIds = (cb: TimelineClipboardItem): string[] =>
  (ITEM_KINDS[cb.kind] as ItemKindDef<ItemKind>).assetIds(cb.item as never);

/** A clipboard item as it lands in another project: what crosses, on the
 * copies' ids. */
export function clipboardItemAcross(cb: TimelineClipboardItem, to: (id: string) => string): TimelineClipboardItem {
  const def = ITEM_KINDS[cb.kind] as ItemKindDef<ItemKind>;
  return { kind: cb.kind, item: def.remapAssets(def.crossProject(cb.item as never), to) } as TimelineClipboardItem;
}

/** Every asset id the lists name: the media the timeline plays and what is
 * baked or set on it. */
export function listedAssetIds(s: ItemLists): Set<string> {
  const used = new Set<string>();
  for (const kind of ITEM_KIND_IDS) {
    const def = ITEM_KINDS[kind] as ItemKindDef<ItemKind>;
    for (const item of def.list(s) as never[]) for (const id of def.assetIds(item)) used.add(id);
  }
  return used;
}

/** Every asset id whose picture the frame draws: the clips on every video
 * track with what is baked for them, and the elements. What a render has to
 * read the color of before its first frame. */
export const pictureAssetIds = (s: Pick<ItemLists, "clips" | "overlays">): Set<string> =>
  listedAssetIds({ clips: s.clips, overlays: s.overlays, audioClips: [], transitions: [], subtitles: { cues: [] } });

/** The drawn lists of a stored document as it comes off disk or the wire,
 * before the loader folds it: an older doc keeps its upper-track clips in
 * `overlayClips`. */
export const drawnLists = (doc: {
  clips?: VideoClip[];
  overlayClips?: VideoClip[];
  overlays?: Overlay[];
}): Pick<ItemLists, "clips" | "overlays"> => ({
  clips: [...(doc.clips ?? []), ...(doc.overlayClips ?? [])],
  overlays: doc.overlays ?? [],
});

/** A switch over kinds is complete or it does not compile. */
export const assertNever = (x: never): never => {
  throw new Error(`Unhandled item kind ${String(x)}`);
};

/** Explicit editing capability, shared by controls and commands. */
export const canSplitItem = (kind: ItemKind) => ITEM_KINDS[kind].split !== null;
