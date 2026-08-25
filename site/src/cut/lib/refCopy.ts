"use client";

/**
 * ⌘C on anything referenceable, everywhere in the app.
 *
 * A card, a tile or a chat asset registers what it stands for as an
 * {@link AssetRef}; ⌘C writes that ref's mention token to the system clipboard,
 * and pasting it into any prompt — the chat composer, the image and video
 * creators — brings the thing itself along, because the composer resolves
 * mention tokens back to refs on send (`collectRefs`).
 *
 * One registry serves every surface. Sources register through
 * {@link useRefCopy}; panel tiles that already mark themselves with
 * `data-pick-id` (effects, transitions, shapes, generated stills) are resolved
 * straight off that attribute, so those grids need no wiring of their own.
 *
 * What a ⌘C copies is what the pointer is on, falling back to what has focus —
 * the cursor is the deliberate pick, and a tile clicked a moment ago keeps
 * focus long after the pointer has moved on.
 */

import { useCallback, useEffect, useRef } from "react";

import {
  catalogRefForPick,
  projectRefs,
  refFromAsset,
  refToken,
  type AssetRef,
} from "./assetRef";
import { useEditor } from "./store";

type RefsFn = () => AssetRef[];

interface CopySource {
  el: HTMLElement;
  refs: RefsFn;
}

/** The registry lives on the window. A hot reload re-evaluates this module,
 * and a module-scoped Set would leave the already-installed listener reading an
 * empty registry while fresh cards register into a Set nothing listens to. */
interface Registry {
  sources: Set<CopySource>;
  /** Where the pointer last was, so a ⌘C copies what the cursor is on. */
  x: number;
  y: number;
  installed: boolean;
}

const registry: Registry = ((globalThis as unknown as { __cutRefCopy?: Registry })
  .__cutRefCopy ??= { sources: new Set<CopySource>(), x: -1, y: -1, installed: false });

const sources = registry.sources;

/** The innermost registered source holding `node`. */
function sourceFor(node: Node | null): CopySource | null {
  if (!node) return null;
  let best: CopySource | null = null;
  for (const s of sources) {
    if (!s.el.contains(node)) continue;
    // A card inside a grid that also registers wins: the smaller box is the
    // more specific answer.
    if (!best || best.el.contains(s.el)) best = s;
  }
  return best;
}

/** A panel tile's pick id resolves without registration: the catalogs
 * (`effect:zoom`, `transition:crossfade`, `shape:rect`) and the generated
 * stills and stickers, whose pick id is their project asset id. */
function refForPickId(pickId: string): AssetRef | null {
  const catalog = catalogRefForPick(pickId);
  if (catalog) return catalog;
  const asset = useEditor.getState().assets.find((a) => a.id === pickId);
  return asset ? refFromAsset(asset) : null;
}

/** What a ⌘C at `node` names, registration first, then the pick id the tile
 * already carries. */
function refsAt(node: Node | null): AssetRef[] {
  const registered = sourceFor(node);
  if (registered) return registered.refs();
  const tile = (node instanceof Element ? node : node?.parentElement)?.closest?.(
    "[data-pick-id]"
  );
  const pickId = tile instanceof HTMLElement ? tile.dataset.pickId : null;
  const ref = pickId ? refForPickId(pickId) : null;
  return ref ? [ref] : [];
}

/** Short handles (`v2`, `i1`) are derived per session and never stored, so the
 * keystroke resolves them against the live asset list. */
function withHandle(ref: AssetRef): AssetRef {
  if (ref.scope !== "project") return ref;
  const live = projectRefs(useEditor.getState().assets).find((r) => r.id === ref.id);
  return live?.handle ? { ...ref, handle: live.handle } : ref;
}

/** Whether the keyboard is in a text field, where ⌘C means the native copy. */
function inTextField(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el.isContentEditable
  );
}

/** The input types that carry a text range; the rest report none. */
const SELECTABLE_INPUT = new Set(["text", "search", "url", "tel", "password"]);

/** Whether the user has text picked out, which makes a ⌘C mean copy that text.
 * `window.getSelection()` covers the page and contenteditable; a range inside
 * an input or a textarea shows up only on the field itself, so a highlighted
 * sentence in the chat composer reads as empty there and has to be asked for
 * directly. */
function hasTextSelection(): boolean {
  if (window.getSelection()?.toString()) return true;
  const el = document.activeElement;
  const field =
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && SELECTABLE_INPUT.has(el.type));
  if (!field) return false;
  const { selectionStart: from, selectionEnd: to } = el;
  return from !== null && to !== null && to > from;
}

/**
 * The refs a ⌘C right now would copy — empty when the pointer and the focus
 * are both off any referenceable thing. The editor's own ⌘C reads this to know
 * when to stand aside and let the copy land on the card under the cursor
 * instead of the timeline selection.
 *
 * Text the user has picked out owns the keystroke. Failing that the pointer
 * answers: a card under the cursor is the deliberate pick even while the caret
 * sits in the chat composer. Focus answers last — a tile clicked a moment ago
 * keeps focus long after the pointer has moved on — and a text field with the
 * caret in it keeps the native copy.
 */
export function copyableRefs(): AssetRef[] {
  // Text the user picked out owns the keystroke, wherever it was picked.
  if (hasTextSelection()) return [];
  const under = registry.x >= 0 ? document.elementFromPoint(registry.x, registry.y) : null;
  const hovered = refsAt(under);
  if (hovered.length > 0) return hovered.map(withHandle);
  if (inTextField()) return [];
  return refsAt(document.activeElement).map(withHandle);
}

/** The clipboard text for a set of refs: their mention tokens, space-joined. */
export const refClipboardText = (refs: AssetRef[]) => refs.map(refToken).join(" ");

/**
 * Put refs on the system clipboard. The tile's own copy buttons and the ⌘C
 * path both land here, so what a click copies and what the keystroke copies
 * are the same string.
 */
export function copyRefs(refs: AssetRef[]): boolean {
  if (refs.length === 0) return false;
  void navigator.clipboard?.writeText(refClipboardText(refs.map(withHandle))).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// The one listener

function install() {
  if (typeof document === "undefined") return;
  if (registry.installed) return;
  registry.installed = true;
  window.addEventListener(
    "pointermove",
    (e) => {
      registry.x = e.clientX;
      registry.y = e.clientY;
    },
    { capture: true, passive: true }
  );
  // A `copy` event fires only where the browser sees something to copy, so the
  // keystroke is what a bare card under the cursor answers to. Bubbling on the
  // document puts this ahead of the editor's own window-level ⌘C, which reads
  // `copyableRefs` and stands aside when a card answers.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "c") return;
    const refs = copyableRefs();
    if (refs.length === 0) return;
    e.preventDefault();
    copyRefs(refs);
  });
}

// The keystroke reaches surfaces that register nothing of their own — a panel
// of effect tiles resolved off `data-pick-id` — so the listener goes on with
// the module rather than with the first source.
install();

/**
 * Register an element as what a ⌘C over it copies. `refs` is read at the
 * keystroke, so a card can answer with the whole selection it belongs to.
 *
 *     const copyRef = useRefCopy(() => [refFromLibrary(asset)]);
 *     <div ref={copyRef}>…</div>
 */
export function useRefCopy(refs: RefsFn): (el: HTMLElement | null) => void {
  const latest = useRef(refs);
  useEffect(() => {
    latest.current = refs;
  });
  const source = useRef<CopySource | null>(null);
  return useCallback((el: HTMLElement | null) => {
    if (source.current) {
      sources.delete(source.current);
      source.current = null;
    }
    if (!el) return;
    source.current = { el, refs: () => latest.current() };
    sources.add(source.current);
  }, []);
}
