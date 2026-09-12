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

import {
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
  /** The list this kind lives in. */
  list(s: ItemLists): ItemOf[K][];
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

export const ITEM_KINDS: { [K in ItemKind]: ItemKindDef<K> } = {
  clip: {
    list: (s) => s.clips,
    clone: deep,
    assetIds: (c) =>
      [c.assetId, c.removal?.matte?.assetId, c.removal?.backdrop?.assetId].filter(
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
    }),
    // A background removal's matte was baked from this project's footage,
    // and a clip arriving with a removal and no matte would start a fresh
    // bake on its own.
    crossProject: (c) => {
      const out = { ...c };
      delete out.removal;
      return out;
    },
  },
  audio: {
    list: (s) => s.audioClips,
    clone: deep,
    assetIds: (a) => (a.assetId ? [a.assetId] : []),
    remapAssets: (a, to) => ({ ...a, assetId: to(a.assetId) }),
    crossProject: (a) => a,
  },
  overlay: {
    list: (s) => s.overlays,
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
    clone: deep,
    assetIds: () => [],
    remapAssets: (c) => c,
    crossProject: (c) => c,
  },
  transition: {
    list: (s) => s.transitions,
    clone: deep,
    assetIds: () => [],
    remapAssets: (t) => t,
    crossProject: (t) => t,
  },
};

export const ITEM_KIND_IDS = Object.keys(ITEM_KINDS) as ItemKind[];

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

/** A switch over kinds is complete or it does not compile. */
export const assertNever = (x: never): never => {
  throw new Error(`Unhandled item kind ${String(x)}`);
};
