"use client";

import type React from "react";
import { clearRefDrag, refFromAsset, refFromLibrary, setRefDragData } from "./assetRef";
import type { LibraryAsset, LibraryTemplateItem } from "./library";
import { useEditor } from "./store";
import type { LibraryTemplate, ShapeKind, TransitionStyle } from "./types";
import type { EffectId } from "@donkeycut/effects-kit";

/** Internal HTML5 drag payload for project media assets. The custom MIME
 * keeps these drags invisible to the window-level OS-file import overlay,
 * which only reacts to `Files`. */
export const ASSET_MIME = "application/x-cut-asset";

/** The asset id of the in-flight drag. `getData` is drop-only, so a drop
 * target that needs the id during `dragover` (e.g. to size an insertion
 * preview) reads it here instead. */
let inFlightAssetId: string | null = null;
/** The whole group a drag is carrying, the grabbed one first. A single card
 * carries itself; a card inside a marquee selection carries the selection, so
 * one drop lays the lot down. */
let inFlightAssetIds: string[] = [];

export function setAssetDragData(e: React.DragEvent, assetId: string, group?: string[]) {
  e.dataTransfer.setData(ASSET_MIME, assetId);
  e.dataTransfer.effectAllowed = "copyMove";
  inFlightAssetId = assetId;
  inFlightAssetIds = groupWithLead(assetId, group);
  // Every media drag also carries the unified asset ref, so reference drop
  // zones (AI chat, the image/video creators) accept it without knowing the
  // source surface.
  const asset = useEditor.getState().assets.find((a) => a.id === assetId);
  if (asset) setRefDragData(e, refFromAsset(asset));
}

/** The asset id currently being dragged, readable during `dragover`. */
export function draggingAssetId(): string | null {
  return inFlightAssetId;
}

/** Every asset id the drag is carrying, the grabbed one first. */
export function draggingAssetIds(): string[] {
  return inFlightAssetIds;
}

/** The grabbed item, then the rest of its group — a drop lands them in that
 * order. A grab outside the selection carries only itself. */
function groupWithLead<T>(lead: T, group: T[] | undefined, same?: (a: T, b: T) => boolean): T[] {
  const eq = same ?? ((a: T, b: T) => a === b);
  if (!group || !group.some((g) => eq(g, lead))) return [lead];
  return [lead, ...group.filter((g) => !eq(g, lead))];
}

/** A library asset dragged from the library panel. Unlike a project asset it is
 * not in the project yet, so it carries its own MIME and a minimal shape the
 * timeline uses to size the drop preview before the copy-into-project happens. */
export const LIBRARY_MIME = "application/x-cut-library";

let inFlightLibrary: LibraryAsset | null = null;
let inFlightLibraryMany: LibraryAsset[] = [];

export function setLibraryDragData(
  e: React.DragEvent,
  asset: LibraryAsset,
  group?: LibraryAsset[]
) {
  e.dataTransfer.setData(LIBRARY_MIME, asset.id);
  e.dataTransfer.effectAllowed = "copy";
  inFlightLibrary = asset;
  inFlightLibraryMany = groupWithLead(asset, group, (a, b) => a.id === b.id);
  setRefDragData(e, refFromLibrary(asset));
}

export function draggingLibrary(): LibraryAsset | null {
  return inFlightLibrary;
}

/** Every library asset the drag is carrying, the grabbed one first. */
export function draggingLibraryMany(): LibraryAsset[] {
  return inFlightLibraryMany;
}

export function hasLibraryDrag(e: React.DragEvent | DragEvent): boolean {
  const dt = "dataTransfer" in e ? e.dataTransfer : null;
  return !!dt && Array.from(dt.types).includes(LIBRARY_MIME);
}

export function draggedLibraryId(e: React.DragEvent | DragEvent): string | null {
  const dt = "dataTransfer" in e ? e.dataTransfer : null;
  if (!dt || !Array.from(dt.types).includes(LIBRARY_MIME)) return null;
  return dt.getData(LIBRARY_MIME) || null;
}

/** A template dragged from the Media panel (project scope) or the Library
 * panel (library scope), so the rail tiles can move it the other way. A
 * library template carries the shelf it sits on; a project one lives in the
 * open project and needs no residency. */
export const TEMPLATE_MIME = "application/x-cut-template";

export type TemplateDrag =
  | { scope: "project"; template: LibraryTemplate }
  | { scope: "library"; template: LibraryTemplateItem };

let inFlightTemplate: TemplateDrag | null = null;

export function setTemplateDragData(e: React.DragEvent, drag: TemplateDrag) {
  e.dataTransfer.setData(TEMPLATE_MIME, drag.template.id);
  e.dataTransfer.effectAllowed = "copy";
  inFlightTemplate = drag;
}

/** The template drag in flight, readable during `dragover`. */
export function draggingTemplate() {
  return inFlightTemplate;
}

export function hasTemplateDrag(e: React.DragEvent | DragEvent): boolean {
  const dt = "dataTransfer" in e ? e.dataTransfer : null;
  return !!dt && Array.from(dt.types).includes(TEMPLATE_MIME);
}

/**
 * A new element dragged out of a panel — a shape or an effect. It exists
 * nowhere yet, so the drag carries what to build rather than an id, and the
 * timeline makes it where it lands.
 */
export const ELEMENT_MIME = "application/x-cut-element";

export type ElementDrag =
  | { kind: "shape"; shape: ShapeKind }
  | { kind: "effect"; effect: EffectId }
  /** A transition joins two clips, so this one lands on a cut rather than at
   * the pointer's exact time. */
  | { kind: "transition"; style: TransitionStyle };

let inFlightElement: ElementDrag | null = null;

export function setElementDragData(e: React.DragEvent, spec: ElementDrag) {
  e.dataTransfer.setData(
    ELEMENT_MIME,
    spec.kind === "shape" ? spec.shape : spec.kind === "effect" ? spec.effect : spec.style
  );
  // Drop surfaces pick the cursor: the timeline shows the drag as a bar in
  // hand and asks for "move" so no copy badge rides it; other zones keep
  // "copy".
  e.dataTransfer.effectAllowed = "copyMove";
  inFlightElement = spec;
}

/** The element being dragged, readable during `dragover` and on drop. */
export function draggingElement(): ElementDrag | null {
  return inFlightElement;
}

export function hasElementDrag(e: React.DragEvent | DragEvent): boolean {
  const dt = "dataTransfer" in e ? e.dataTransfer : null;
  return !!dt && Array.from(dt.types).includes(ELEMENT_MIME);
}

export function clearElementDrag() {
  inFlightElement = null;
}

/** Longest side of a card drag ghost, px. */
const CARD_GHOST_MAX = 72;

/** Use the card itself as the drag ghost: a scaled-down clone, so the
 * ghost matches the card exactly — rounded corners, fills, labels. A card can
 * narrow the ghost to just its picture: the ghost clones the node marked
 * `data-drag-object` when one exists, and drops anything marked
 * `data-drag-omit` (badges riding on the picture, a name strip under a
 * figure). Live `<video>`/`<canvas>`
 * content is baked into the clone (clones of those paint blank), and
 * hover-revealed controls drop out since the clone is not hovered. The clone
 * lives off-screen just long enough for the browser to snapshot it. */
/** Ready a clone for ghost duty: drop `data-drag-omit` nodes (badges riding on
 * the picture) and bake live `<video>`/`<canvas>` frames into canvases, since
 * clones of those paint blank. */
function bakeGhostClone(src: HTMLElement, clone: HTMLElement): void {
  clone.querySelectorAll("[data-drag-omit]").forEach((n) => n.remove());
  // Skip media inside omitted nodes so both lists pair up by index.
  const srcMedia = Array.from(src.querySelectorAll<HTMLElement>("video, canvas")).filter(
    (n) => !n.closest("[data-drag-omit]")
  );
  clone.querySelectorAll<HTMLElement>("video, canvas").forEach((node, i) => {
    const from = srcMedia[i];
    if (!from) return;
    const r = from.getBoundingClientRect();
    // A video with no decoded frame yet paints nothing; its poster is what the
    // page is showing, so the ghost shows the poster too.
    if (from instanceof HTMLVideoElement && from.readyState < 2 && from.poster) {
      const img = document.createElement("img");
      img.src = from.poster;
      img.className = node.className;
      img.style.cssText = node.style.cssText;
      img.style.width = `${r.width}px`;
      img.style.height = `${r.height}px`;
      img.style.objectFit = "cover";
      node.replaceWith(img);
      return;
    }
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(r.width * devicePixelRatio));
    c.height = Math.max(1, Math.round(r.height * devicePixelRatio));
    c.className = node.className;
    c.style.cssText = node.style.cssText;
    c.style.width = `${r.width}px`;
    c.style.height = `${r.height}px`;
    const ctx = c.getContext("2d");
    if (ctx) {
      try {
        if (from instanceof HTMLVideoElement) {
          // Match object-cover: scale to fill and center-crop.
          const vw = from.videoWidth || r.width;
          const vh = from.videoHeight || r.height;
          const scale = Math.max(c.width / vw, c.height / vh);
          ctx.drawImage(
            from,
            (c.width - vw * scale) / 2,
            (c.height - vh * scale) / 2,
            vw * scale,
            vh * scale
          );
        } else {
          ctx.drawImage(from as HTMLCanvasElement, 0, 0, c.width, c.height);
        }
      } catch {
        // A frame that cannot be painted just leaves that slot blank.
      }
    }
    node.replaceWith(c);
  });
}

export function setCardDragImage(e: React.DragEvent, host: HTMLElement) {
  const el = host.querySelector<HTMLElement>("[data-drag-object]") ?? host;
  const rect = el.getBoundingClientRect();
  const clone = el.cloneNode(true) as HTMLElement;
  bakeGhostClone(el, clone);
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.margin = "0";
  // Compact ghost: the card at full size blankets the rows it is dragged
  // across, so it shrinks to a thumbnail, scaled around the grab point.
  const scale = Math.min(1, CARD_GHOST_MAX / Math.max(rect.width, rect.height));
  clone.style.transform = `scale(${scale})`;
  clone.style.transformOrigin = "top left";
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:absolute;top:-1000px;left:-1000px;pointer-events:none;" +
    `width:${rect.width * scale}px;height:${rect.height * scale}px;`;
  wrap.appendChild(clone);
  document.body.appendChild(wrap);
  // A grab outside the snapshot (on the card's label) holds the nearest edge.
  e.dataTransfer.setDragImage(
    wrap,
    Math.min(Math.max(e.clientX - rect.left, 0), rect.width) * scale,
    Math.min(Math.max(e.clientY - rect.top, 0), rect.height) * scale
  );
  setTimeout(() => wrap.remove(), 0);
}

/** The dragged thing itself as the ghost: the tile's `data-drag-object` node —
 * the shape silhouette, the sticker picture, the effect or transition swatch —
 * cloned alone on a transparent backdrop, so the drag reads as carrying the
 * object rather than a snapshot of the whole card with its border and label.
 * Falls back to the drag source when no node is marked.
 *
 * The visible ghost is our own fixed-position layer under a blank native drag
 * image. A native ghost is frozen at dragstart; the layer can keep reacting,
 * so when the drag crosses a surface that paints its own landing preview
 * (marked `data-segment-drop`, e.g. the timeline with its track-segment
 * ghost) the object shrinks away and hands over, then returns if the drag
 * leaves again. */
/** Uniform drag-ghost unit, px: every drag rides the same square marker, the
 * grabbed tile's picture covering it edge to edge — center-cropped to fill,
 * so no aspect leaves bars. A node marked `data-drag-object="bare"` — a
 * folder glyph — is the marker itself: fitted whole into the unit, with no
 * frame, fill or shadow around it. */
const OBJECT_GHOST_UNIT = 48;

export function setObjectDragImage(
  e: React.DragEvent,
  count = 1,
  gatherIds?: string[],
  /** Runs when the drop lands on a surface that accepted it — the moment the
   * carried items have a new home, so the source clears its selection. A dead
   * release flies the pick home and leaves the selection standing. */
  onLanded?: () => void
) {
  const host = e.currentTarget as HTMLElement;
  const el = host.querySelector<HTMLElement>("[data-drag-object]") ?? host;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const unit = OBJECT_GHOST_UNIT;
  const bare = el.dataset.dragObject === "bare";

  const blank = document.createElement("canvas");
  blank.width = blank.height = 1;
  blank.style.cssText = "position:absolute;top:-1000px;left:-1000px;";
  document.body.appendChild(blank);
  e.dataTransfer.setDragImage(blank, 0, 0);
  setTimeout(() => blank.remove(), 0);

  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;left:0;top:0;z-index:1000;pointer-events:none;will-change:transform;";
  const object = el.cloneNode(true) as HTMLElement;
  bakeGhostClone(el, object);
  object.style.width = `${rect.width}px`;
  object.style.height = `${rect.height}px`;
  object.style.margin = "0";
  // The clone keeps the tile's grid classes; inside the tiny frame those
  // clamp it (max-w-full reads the 48px frame as the containing block), so
  // the explicit on-screen size is pinned open.
  object.style.maxWidth = "none";
  object.style.maxHeight = "none";
  object.style.minWidth = "0";
  object.style.minHeight = "0";
  // Center the full-size clone in the unit and scale it to cover: the picture
  // fills the square and the long dimension crops away. A bare object is
  // fitted whole instead.
  const cover = bare
    ? Math.min(unit / rect.width, unit / rect.height)
    : Math.max(unit / rect.width, unit / rect.height);
  object.style.position = "absolute";
  object.style.left = `${(unit - rect.width) / 2}px`;
  object.style.top = `${(unit - rect.height) / 2}px`;
  object.style.transform = `scale(${cover})`;
  object.style.transformOrigin = "center";
  const frame = document.createElement("div");
  frame.style.cssText = "position:absolute;inset:0;";
  if (!bare) {
    frame.style.cssText +=
      "overflow:hidden;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.35);";
    // The tile's own fill backs the picture while it loads.
    const fill = getComputedStyle(el).backgroundColor;
    frame.style.background =
      fill && fill !== "rgba(0, 0, 0, 0)" ? fill : "rgba(30,30,38,0.9)";
    // The ghost floats free of the page, so a tile that wears an edge in the
    // grid gets it drawn at twice the strength: a pale tile lifted over a pale
    // backdrop has no shape otherwise. A borderless tile stays borderless.
    const tile = getComputedStyle(el);
    if (parseFloat(tile.borderTopWidth) > 0)
      frame.style.border = `1px solid color-mix(in oklab, ${tile.borderTopColor}, black 50%)`;
  }
  frame.appendChild(object);
  const bundle = document.createElement("div");
  bundle.style.cssText =
    `position:relative;width:${unit}px;height:${unit}px;opacity:0.85;` +
    "transition:opacity 150ms ease, transform 150ms ease;";

  // A multi-selection reads as one thing in hand: a stack gathered behind the
  // grabbed card, counted on its corner.
  if (count > 1) {
    for (const [dx, dy, rot] of [
      [6, 6, 4],
      [3, 3, 2],
    ]) {
      const back = document.createElement("div");
      back.style.cssText =
        `position:absolute;inset:0;transform:translate(${dx}px,${dy}px) rotate(${rot}deg);` +
        "border-radius:8px;background:rgba(30,30,38,0.55);";
      bundle.appendChild(back);
    }
  }
  bundle.appendChild(frame);
  if (count > 1) {
    const badge = document.createElement("span");
    badge.textContent = String(count);
    badge.style.cssText =
      "position:absolute;top:-8px;right:-8px;z-index:1;min-width:20px;height:20px;padding:0 5px;" +
      "display:grid;place-items:center;border-radius:10px;background:#0a84ff;color:#fff;" +
      "font:600 11px/1 ui-sans-serif,system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.35);";
    bundle.appendChild(badge);
  }
  root.appendChild(bundle);
  document.body.appendChild(root);

  // Hold the ghost where the pointer grabbed the card, mapped onto the unit;
  // a grab outside the object holds the nearest edge.
  const gx = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1) * unit;
  const gy = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1) * unit;
  bundle.style.transformOrigin = `${gx}px ${gy}px`;

  const position = (x: number, y: number) => {
    root.style.transform = `translate(${x - gx}px, ${y - gy}px)`;
  };
  position(e.clientX, e.clientY);

  // The rest of the selection gathers into the stack: each picked card
  // flies from its grid spot to the ghost, shrinking away as it lands. A
  // huge selection animates only its first few — the count badge carries the
  // rest. Every flier is tracked so a release removes them on the spot.
  const flies: HTMLElement[] = [];
  if (count > 1 && gatherIds) {
    for (const id of gatherIds.slice(0, 8)) {
      const src = document.querySelector<HTMLElement>(`[data-sel-id="${CSS.escape(id)}"]`);
      if (!src || src === host || src.contains(el)) continue;
      const from = src.querySelector<HTMLElement>("[data-drag-object]") ?? src;
      const r = from.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const fly = from.cloneNode(true) as HTMLElement;
      bakeGhostClone(from, fly);
      fly.style.cssText +=
        `;position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
        "margin:0;pointer-events:none;z-index:999;opacity:0.9;transform-origin:top left;" +
        "transition:transform 240ms ease, opacity 240ms ease;";
      document.body.appendChild(fly);
      flies.push(fly);
      const tx = e.clientX - gx - r.left;
      const ty = e.clientY - gy - r.top;
      requestAnimationFrame(() => {
        fly.style.transform = `translate(${tx}px, ${ty}px) scale(${unit / Math.max(r.width, r.height)})`;
        fly.style.opacity = "0";
      });
      setTimeout(() => fly.remove(), 300);
    }
  }

  // Where the pointer last was: `dragend` reports no position on every
  // platform, and a release nothing wanted flies home from here.
  let lastX = e.clientX;
  let lastY = e.clientY;
  const onOver = (ev: DragEvent) => {
    // A real target has already claimed this event by the time it reaches the
    // document, so its `defaultPrevented` is what says the spot takes a drop.
    // Dead space accepts the drag too, which keeps the native snap-back
    // animation from holding `dragend` — and the ghost — for a beat after a
    // release nothing wanted. The cursor still reads as no-drop; with the
    // effect at none the browser fires no `drop` for the release, so
    // `dragend` below is what sends the pick home.
    if (!ev.defaultPrevented && ev.dataTransfer) ev.dataTransfer.dropEffect = "none";
    ev.preventDefault();
    lastX = ev.clientX;
    lastY = ev.clientY;
    position(ev.clientX, ev.clientY);
    const handedOver = !!(ev.target as Element | null)?.closest?.("[data-segment-drop]");
    bundle.style.opacity = handedOver ? "0" : "0.85";
    bundle.style.transform = handedOver ? "scale(0.3)" : "";
  };
  // A release nothing accepted sends the pick home: the stack shrinks away
  // and each carried card flies from the release point back to its spot in
  // the grid, dissolving onto the original as it lands.
  const flyHome = (x: number, y: number) => {
    bundle.style.opacity = "0";
    bundle.style.transform = "scale(0.5)";
    setTimeout(() => root.remove(), 160);
    const homes: HTMLElement[] = [];
    if (count > 1 && gatherIds) {
      for (const id of gatherIds.slice(0, 8)) {
        const src = document.querySelector<HTMLElement>(`[data-sel-id="${CSS.escape(id)}"]`);
        if (src) homes.push(src.querySelector<HTMLElement>("[data-drag-object]") ?? src);
      }
    } else {
      homes.push(el);
    }
    for (const home of homes) {
      const r = home.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const back = home.cloneNode(true) as HTMLElement;
      bakeGhostClone(home, back);
      back.style.cssText +=
        `;position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
        "max-width:none;max-height:none;min-width:0;min-height:0;" +
        "margin:0;pointer-events:none;z-index:999;opacity:0.9;transform-origin:top left;" +
        `transform:translate(${x - gx - r.left}px, ${y - gy - r.top}px) scale(${unit / Math.max(r.width, r.height)});` +
        "transition:transform 260ms ease, opacity 120ms ease 160ms;";
      document.body.appendChild(back);
      requestAnimationFrame(() => {
        back.style.transform = "";
        back.style.opacity = "0";
      });
      setTimeout(() => back.remove(), 320);
    }
  };
  // The drop landed: the ghost goes at once and the source lets go of its
  // selection, since the carried items have a new home.
  const landed = () => {
    root.remove();
    onLanded?.();
  };
  // Letting go settles the ghost at once — flyers still gathering in clear
  // with it. Every listener detaches on the first verdict; the rest are
  // no-ops.
  let settled = false;
  const detach = () => {
    settled = true;
    for (const fly of flies) fly.remove();
    document.removeEventListener("dragover", onOver);
    window.removeEventListener("drop", onDrop, true);
    window.removeEventListener("dragend", onEnd, true);
  };
  // The verdict on a release comes from the drop event itself, never from a
  // flag kept during the drag: a target that stops the drop or the dragovers
  // from bubbling (a timeline row, say) still passes this capture listener at
  // the window, ahead of every handler. Whether it took the drop is only
  // known once dispatch is over, so the verdict waits a task and reads the
  // event's `defaultPrevented` — set by any handler that acted on the drop.
  let dropSeen = false;
  const onDrop = (ev: DragEvent) => {
    dropSeen = true;
    const x = ev.clientX;
    const y = ev.clientY;
    setTimeout(() => {
      if (settled) return;
      detach();
      if (ev.defaultPrevented) landed();
      else flyHome(x, y);
    }, 0);
  };
  // `dragend` fires for every drag, including one released outside the
  // window. When no `drop` came first, the browser's own effect says whether
  // anything took it: none means the pick goes home from where it was last
  // seen. When a drop was seen, its own verdict above decides.
  const onEnd = (ev: DragEvent) => {
    if (settled || dropSeen) return;
    detach();
    if (ev.dataTransfer?.dropEffect === "none") flyHome(lastX, lastY);
    else landed();
  };
  document.addEventListener("dragover", onOver);
  window.addEventListener("drop", onDrop, true);
  window.addEventListener("dragend", onEnd, true);
}

/** A small chip as the drag image, so the cursor carries a compact marker
 * instead of the full card snapshot that blankets the timeline track. The
 * timeline renders its own on-track segment ghost for where the clip lands; the
 * chip is just the "I'm holding something" cursor. A solid div paints
 * synchronously (no image-load race), so it works the first drag too. */
export function setChipDragImage(e: React.DragEvent) {
  const chip = document.createElement("div");
  chip.style.cssText =
    "position:absolute;top:-1000px;left:-1000px;width:60px;height:34px;border-radius:6px;" +
    "background:#e5e5e5;box-shadow:0 6px 16px rgba(0,0,0,0.35),inset 0 0 0 1.5px rgba(10,132,255,0.7);";
  document.body.appendChild(chip);
  e.dataTransfer.setDragImage(chip, 30, 17);
  setTimeout(() => chip.remove(), 0);
}

/** Clear the in-flight ids; call on `dragend` and after a drop. */
export function clearAssetDrag() {
  inFlightAssetId = null;
  inFlightAssetIds = [];
  inFlightLibrary = null;
  inFlightLibraryMany = [];
  inFlightTemplate = null;
  clearRefDrag();
}

export function draggedAssetId(e: React.DragEvent | DragEvent): string | null {
  const dt = "dataTransfer" in e ? e.dataTransfer : null;
  if (!dt || !Array.from(dt.types).includes(ASSET_MIME)) return null;
  return dt.getData(ASSET_MIME) || null;
}

/** True while dragging (getData is only readable on drop). */
export function hasAssetDrag(e: React.DragEvent | DragEvent): boolean {
  const dt = "dataTransfer" in e ? e.dataTransfer : null;
  return !!dt && Array.from(dt.types).includes(ASSET_MIME);
}
