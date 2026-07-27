"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { fetchLibrary, libraryMediaUrl, type LibraryAsset } from "./library";
import { stockTitle, type StockImage, type StockMusic, type StockVideo } from "./stock";
import { STOCK_IMAGES } from "./stockManifest";
import { STOCK_VIDEOS } from "./stockVideoManifest";
import { clipLen, getClipSpans, useEditor } from "./store";
import type { AudioClip, MediaAsset } from "./types";

// One reference model for every piece of media in the app. A ref names an
// asset wherever it lives — the open project, the shared library, the bundled
// stock catalog, or a file dropped straight from the desktop — with enough to
// preview it (url, kind, duration) and to hand it to whatever wants it: an AI
// chat attachment, an image/video generation reference, or a timeline drop.
//
// Refs travel two ways:
// - Native HTML5 drags (cards, tiles, chat) carry a REF_MIME JSON payload;
//   `setRefDragData` on the source, `useAssetDrop` on the target.
// - Pointer drags (timeline clips, which move via pointer capture, not DnD)
//   deliver through the same drop-zone registry with `startPointerRefDrag`.
//
// Refs are also written as mentions in prompt text — `@v2` by short handle or
// `@"asset name"` by name. `refToken` makes the token, `parseMentions`
// resolves tokens back to refs on send.

/** "file" marks a transient ref made from a desktop drop (a text file riding a
 * composer) — it lives only in the composer's state, never in a catalog.
 * "clip" names a clip on the timeline — a video-track clip or a soundtrack
 * clip (id = the clip id, url = its source media), so chat can talk about
 * segments of the cut, not just assets. */
export type AssetRefScope = "project" | "library" | "stock" | "file" | "clip";
export type AssetRefKind = "video" | "audio" | "image" | "text";

export interface AssetRef {
  scope: AssetRefScope;
  id: string;
  /** Display name; mentions resolve against it (`@"beach sunset"`). */
  name: string;
  kind: AssetRefKind;
  /** Fetchable URL for the media itself (previews and frame capture). */
  url: string;
  duration?: number;
  /** Short mention handle (`v2`, `i1`, `a3`), assigned to project assets in
   * media order by `useRefCandidates`. Derived per session, not persisted —
   * display surfaces re-resolve it live so a stale copy never shows. */
  handle?: string;
}

export const refFromAsset = (a: MediaAsset): AssetRef => ({
  scope: "project",
  id: a.id,
  name: a.name,
  kind: a.type,
  url: a.url,
  duration: a.duration,
});

export const refFromLibrary = (a: LibraryAsset): AssetRef => ({
  scope: "library",
  id: a.id,
  name: a.name,
  kind: a.type,
  url: libraryMediaUrl(a.fileName, a.residency),
  duration: a.duration,
});

export const refFromStock = (i: StockImage): AssetRef => ({
  scope: "stock",
  id: i.id,
  name: i.id,
  kind: "image",
  url: i.file,
});

export const refFromStockVideo = (v: StockVideo): AssetRef => ({
  scope: "stock",
  id: v.id,
  name: v.id,
  kind: "video",
  url: v.file,
  duration: v.duration,
});

export const refFromStockMusic = (m: StockMusic): AssetRef => ({
  scope: "stock",
  id: m.id,
  name: stockTitle(m.id),
  kind: "audio",
  url: m.file,
  duration: m.duration,
});

/** A ref for a text file dropped from the desktop: the contents ride inline
 * as a data: URL. The ref persists into the thread's saved messages, and a
 * data: URL still reads after a reload — an object URL would die with the
 * page and leave the attachment permanently unreadable. */
export async function refFromTextFile(file: File): Promise<AssetRef> {
  const url = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error(`Could not read ${file.name}.`));
    r.readAsDataURL(file);
  });
  return {
    scope: "file",
    id: crypto.randomUUID().slice(0, 8),
    name: file.name,
    kind: "text",
    url,
  };
}

export const sameRef = (a: AssetRef, b: AssetRef) => a.scope === b.scope && a.id === b.id;

export const addRefOnce = (list: AssetRef[], ref: AssetRef): AssetRef[] =>
  list.some((r) => sameRef(r, ref)) ? list : [...list, ref];

/** A ref's fetchable URL, re-read from the live catalogs. Cloud asset URLs are
 * short-lived signed R2 URLs, so a ref persisted in a saved chat thread
 * outlives its `url`; project and clip refs resolve through the current asset
 * instead. Library/stock/file URLs are stable routes or data: URLs, and a ref
 * whose asset is gone keeps the persisted URL (its fetch fails either way). */
function liveRefUrl(scope: AssetRefScope, id: string, url: string): string {
  const s = useEditor.getState();
  if (scope === "project") return s.assets.find((a) => a.id === id)?.url ?? url;
  if (scope === "clip") {
    const assetId =
      s.clips.find((c) => c.id === id)?.assetId ??
      s.audioClips.find((c) => c.id === id)?.assetId;
    return s.assets.find((a) => a.id === assetId)?.url ?? url;
  }
  return url;
}

/** Tolerant reader for refs persisted before the scope/kind shape (old chat
 * threads stored `{ id, name, type, duration, url }`). Every persisted ref is
 * rehydrated through here, so this is also where its URL comes back to life. */
export function normalizeRef(v: unknown): AssetRef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Partial<AssetRef> & { type?: AssetRefKind };
  if (!o.id || !o.name || !o.url) return null;
  const scope = o.scope ?? "project";
  return {
    scope,
    id: o.id,
    name: o.name,
    kind: o.kind ?? o.type ?? "video",
    url: liveRefUrl(scope, o.id, o.url),
    duration: o.duration,
  };
}

// ---------------------------------------------------------------------------
// Drag transport

/** Unified drag payload; every internal media drag carries this alongside any
 * surface-specific MIME (timeline placement, folder moves). */
export const REF_MIME = "application/x-cut-ref";

let inFlightRef: AssetRef | null = null;

export function setRefDragData(e: React.DragEvent, ref: AssetRef) {
  e.dataTransfer.setData(REF_MIME, JSON.stringify(ref));
  if (!e.dataTransfer.effectAllowed || e.dataTransfer.effectAllowed === "uninitialized") {
    e.dataTransfer.effectAllowed = "copy";
  }
  inFlightRef = ref;
}

/** The ref currently being dragged, readable during `dragover`. */
export function draggingRef(): AssetRef | null {
  return inFlightRef;
}

export function hasRefDrag(e: React.DragEvent | DragEvent): boolean {
  const dt = "dataTransfer" in e ? e.dataTransfer : null;
  return !!dt && Array.from(dt.types).includes(REF_MIME);
}

export function draggedRef(e: React.DragEvent | DragEvent): AssetRef | null {
  const dt = "dataTransfer" in e ? e.dataTransfer : null;
  if (!dt || !Array.from(dt.types).includes(REF_MIME)) return null;
  try {
    return normalizeRef(JSON.parse(dt.getData(REF_MIME)));
  } catch {
    return null;
  }
}

export function clearRefDrag() {
  inFlightRef = null;
}

// ---------------------------------------------------------------------------
// Drop zones — shared by HTML5 drags and pointer drags

interface RefZone {
  el: HTMLElement;
  onDrop: (ref: AssetRef) => void;
  /** Present when the zone also takes OS file drops (composer attachments). */
  onFiles?: (files: File[]) => void;
  setActive: (active: boolean) => void;
}

const zones = new Set<RefZone>();

/** The file-accepting zone under a window drop, if any. Lets the editor's
 * window-level drop handler hand files to the composer they landed on instead
 * of importing them into the project. */
export function fileZoneAt(x: number, y: number): ((files: File[]) => void) | null {
  for (const z of zones) {
    if (!z.onFiles) continue;
    const r = z.el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return z.onFiles;
  }
  return null;
}

function zoneAt(x: number, y: number): RefZone | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  for (const z of zones) if (z.el.contains(hit)) return z;
  return null;
}

/** Drive a ref through a pointer drag (timeline clips). Call `move` from the
 * drag's onMove so zones under the pointer light up; call `drop` on release —
 * true means a zone took the ref and the source should cancel its own move. */
export function startPointerRefDrag(ref: AssetRef) {
  let x = -1;
  let y = -1;
  return {
    move(ev: PointerEvent) {
      x = ev.clientX;
      y = ev.clientY;
      const z = zoneAt(x, y);
      for (const q of zones) q.setActive(q === z);
    },
    drop(): boolean {
      for (const q of zones) q.setActive(false);
      const z = zoneAt(x, y);
      if (!z) return false;
      z.onDrop(ref);
      return true;
    },
  };
}

/** Make an element accept asset refs from both drag transports:
 * `<div ref={attachTarget} {...targetProps}>` — `active` styles the highlight.
 * Pass `onFiles` to also take OS file drops: the zone highlights during the
 * drag and the editor's window-level drop handler delivers the files here
 * (via `fileZoneAt`) instead of importing them onto the timeline. */
export function useAssetDrop(
  onDrop: (ref: AssetRef) => void,
  onFiles?: (files: File[]) => void
): {
  active: boolean;
  attachTarget: (el: HTMLElement | null) => void;
  targetProps: Pick<
    React.HTMLAttributes<HTMLElement>,
    "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop"
  >;
} {
  const [active, setActive] = useState(false);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const depth = useRef(0);
  const cb = useRef(onDrop);
  const filesCb = useRef(onFiles);
  useEffect(() => {
    cb.current = onDrop;
    filesCb.current = onFiles;
  });

  // Register the element as a drop zone for pointer-drag delivery (and, when
  // it takes files, for the editor's window-drop routing).
  const takesFiles = !!onFiles;
  useEffect(() => {
    if (!el) return;
    const zone: RefZone = {
      el,
      onDrop: (r) => cb.current(r),
      ...(takesFiles && { onFiles: (f: File[]) => filesCb.current?.(f) }),
      setActive,
    };
    zones.add(zone);
    return () => {
      zones.delete(zone);
    };
  }, [el, takesFiles]);

  const attachTarget = useCallback((node: HTMLElement | null) => setEl(node), []);

  const targetProps = useMemo<
    Pick<React.HTMLAttributes<HTMLElement>, "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop">
  >(() => {
    const done = () => {
      depth.current = 0;
      setActive(false);
    };
    // File-taking zones also light up for OS file drags; the drop itself is
    // delivered by the editor's window-level handler through `fileZoneAt`, so
    // here it only clears the highlight and lets the event bubble.
    const accepts = (e: React.DragEvent) =>
      hasRefDrag(e) || (takesFiles && Array.from(e.dataTransfer.types).includes("Files"));
    return {
      onDragEnter: (e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        depth.current += 1;
        setActive(true);
      },
      onDragOver: (e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (e) => {
        if (!accepts(e)) return;
        depth.current -= 1;
        if (depth.current <= 0) done();
      },
      onDrop: (e) => {
        done();
        const ref = draggedRef(e);
        if (!ref) return;
        e.preventDefault();
        cb.current(ref);
      },
    };
  }, [takesFiles]);

  return { active, attachTarget, targetProps };
}

// ---------------------------------------------------------------------------
// Candidates and @name mentions

let libraryCache: LibraryAsset[] | null = null;
let libraryLoad: Promise<LibraryAsset[]> | null = null;

/** The open project's media as refs with their session handles, assigned in
 * media order — `v1` videos, `i1` generated stills, `a1` audio — so a prompt
 * can say `@v2` instead of the full name. Handles are derived, never stored:
 * anything that shows one resolves it from the current asset list.
 * Chat-owned assets (origin "chat") are a run's internals — character sheets,
 * keyframes, takes — visible nowhere the user works, so they don't become
 * candidates; a take placed on the timeline is reachable as its clip (@c2). */
export function projectRefs(assets: MediaAsset[]): AssetRef[] {
  const counters = { v: 0, i: 0, a: 0 };
  return assets
    .filter((a) => a.origin !== "chat")
    .map((a) => {
      const prefix = a.type === "image" ? "i" : a.type === "video" ? "v" : "a";
      counters[prefix] += 1;
      return { ...refFromAsset(a), handle: `${prefix}${counters[prefix]}` };
    });
}

/** The timeline's video-track clips as refs — `c1`, `c2`… in timeline order —
 * so a prompt can point at a segment of the cut ("@c2 doesn't match the
 * audio"). Handles are derived from the current order, never stored; the
 * timeline shows each clip's token on hover. */
export function clipRefs(
  clips: Parameters<typeof getClipSpans>[0],
  assets: MediaAsset[]
): AssetRef[] {
  return getClipSpans(clips, assets).map((sp, i) => ({
    scope: "clip",
    id: sp.clip.id,
    name: `clip ${i + 1}`,
    kind: sp.asset.type === "image" ? "image" : "video",
    url: sp.asset.url,
    duration: sp.len,
    handle: `c${i + 1}`,
  }));
}

/** The soundtrack's audio clips as refs — `s1`, `s2`… in start-time order — so
 * a prompt can point at a sound on the timeline ("@s1 is too loud"). Each ref
 * carries its source audio's URL and `kind: "audio"`, so using the token in
 * chat pulls the actual sound in. Handles are derived from the current order,
 * never stored; the timeline shows each clip's token on hover. A clip whose
 * asset has gone missing is dropped. */
export function audioClipRefs(audioClips: AudioClip[], assets: MediaAsset[]): AssetRef[] {
  return [...audioClips]
    .sort((a, b) => a.start - b.start || (a.lane ?? 0) - (b.lane ?? 0))
    .flatMap((clip, i) => {
      const asset = assets.find((x) => x.id === clip.assetId);
      if (!asset) return [];
      return [
        {
          scope: "clip",
          id: clip.id,
          name: `sound ${i + 1}`,
          kind: "audio",
          url: asset.url,
          duration: clipLen(clip),
          handle: `s${i + 1}`,
        } satisfies AssetRef,
      ];
    });
}

/** Everything referenceable right now, in resolution order: the timeline's
 * clips first — video-track clips, then soundtrack clips (what's in front of
 * the user — a bare `@` leads with the cut), then the open project's media,
 * the shared library, and the stock catalog.
 * Names are unique within the list (first scope wins) so a mention resolves
 * to one asset. Library items mention by name; stock ids are already short
 * (`@nature-dunes`). */
export function useRefCandidates(): AssetRef[] {
  const assets = useEditor((s) => s.assets);
  const clips = useEditor((s) => s.clips);
  const audioClips = useEditor((s) => s.audioClips);
  const [lib, setLib] = useState<LibraryAsset[]>(libraryCache ?? []);

  useEffect(() => {
    libraryLoad ??= fetchLibrary()
      .then((d) => (libraryCache = d.assets))
      .catch(() => (libraryCache = []));
    let alive = true;
    void libraryLoad.then((l) => alive && setLib(l));
    return () => {
      alive = false;
    };
  }, []);

  return useMemo(() => {
    const project = projectRefs(assets);
    const seen = new Set<string>();
    const out: AssetRef[] = [];
    for (const ref of [
      ...clipRefs(clips, assets),
      ...audioClipRefs(audioClips, assets),
      ...project,
      ...lib.map(refFromLibrary),
      ...STOCK_IMAGES.map(refFromStock),
      ...STOCK_VIDEOS.map(refFromStockVideo),
    ]) {
      const key = ref.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
    return out;
  }, [assets, clips, audioClips, lib]);
}

/** The prompt token for an asset name: `@name`, quoted when it has spaces. */
export const mentionToken = (name: string) =>
  /[\s"]/.test(name) ? `@"${name.replace(/"/g, "")}"` : `@${name}`;

/** The preferred prompt token for a ref: its short handle (`@v2`) when it has
 * one, the (quoted) name otherwise. */
export const refToken = (ref: AssetRef) =>
  ref.handle ? `@${ref.handle}` : mentionToken(ref.name);

const MENTION_RE = /@(?:"([^"\n]+)"|([^\s"@]+))/g;

/** Resolve one mention body against the candidates: short handle first
 * (`v2`), then exact name (case-insensitive on both). */
export function resolveRefByName(name: string, candidates: AssetRef[]): AssetRef | null {
  const q = name.toLowerCase();
  return (
    candidates.find((c) => c.handle?.toLowerCase() === q) ??
    candidates.find((c) => c.name.toLowerCase() === q) ??
    null
  );
}

/** Split text into literal runs and resolved mention refs, for rendering
 * tokens as interactive chips (hover peek, click to reveal). Unresolved
 * tokens stay literal text. */
export function splitMentions(text: string, candidates: AssetRef[]): (string | AssetRef)[] {
  const parts: (string | AssetRef)[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const ref = resolveRefByName(m[1] ?? m[2] ?? "", candidates);
    if (!ref) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(ref);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Like {@link splitMentions}, but keeps the literal token text for every
 * resolved mention so an overlay can render it as a pill in place — the
 * rendered characters stay identical to the textarea, so widths align. */
export function highlightMentions(
  text: string,
  candidates: AssetRef[]
): { text: string; ref: AssetRef | null }[] {
  const parts: { text: string; ref: AssetRef | null }[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const ref = resolveRefByName(m[1] ?? m[2] ?? "", candidates);
    if (!ref) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index), ref: null });
    parts.push({ text: m[0], ref });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), ref: null });
  return parts;
}

/** The current candidate ref for a display name — how card affordances find
 * their short handle. Null when nothing referenceable carries the name. */
export function useRefFor(name: string): AssetRef | null {
  const candidates = useRefCandidates();
  return useMemo(
    () => candidates.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null,
    [candidates, name]
  );
}

/** Pull `@name` mentions out of prompt text. Resolved tokens are replaced by
 * the plain asset name (the ref rides along separately); unresolved tokens are
 * left as typed. */
export function parseMentions(
  text: string,
  candidates: AssetRef[]
): { refs: AssetRef[]; text: string } {
  const refs: AssetRef[] = [];
  const out = text.replace(MENTION_RE, (token, quoted: string | undefined, bare: string | undefined) => {
    const ref = resolveRefByName(quoted ?? bare ?? "", candidates);
    if (!ref) return token;
    if (!refs.some((r) => sameRef(r, ref))) refs.push(ref);
    return ref.name;
  });
  return { refs, text: out };
}

/** Resolve a prompt's `@name` mentions and merge them into the already-attached
 * `chips`, de-duplicated. `dropAudio` excludes audio refs — image/video
 * generation take only pictures; chat keeps them. The single place the three
 * send paths (chat, generate image, generate video) share this composition. */
export function collectRefs(
  text: string,
  chips: AssetRef[],
  candidates: AssetRef[],
  opts?: { dropAudio?: boolean }
): { refs: AssetRef[]; text: string } {
  const parsed = parseMentions(text, candidates);
  const mentioned = opts?.dropAudio
    ? parsed.refs.filter((r) => r.kind !== "audio")
    : parsed.refs;
  // Re-resolve each ref's short handle from the live candidates — chips from
  // drags predate handle assignment, and the model reads handles to talk
  // about attachments ("v2").
  const refs = mentioned.reduce(addRefOnce, chips).map((r) => {
    const live = candidates.find((c) => sameRef(c, r));
    return live?.handle ? { ...r, handle: live.handle } : r;
  });
  return { refs, text: parsed.text };
}
