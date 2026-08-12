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

export function setAssetDragData(e: React.DragEvent, assetId: string) {
  e.dataTransfer.setData(ASSET_MIME, assetId);
  e.dataTransfer.effectAllowed = "copyMove";
  inFlightAssetId = assetId;
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

/** A library asset dragged from the library panel. Unlike a project asset it is
 * not in the project yet, so it carries its own MIME and a minimal shape the
 * timeline uses to size the drop preview before the copy-into-project happens. */
export const LIBRARY_MIME = "application/x-cut-library";

let inFlightLibrary: LibraryAsset | null = null;

export function setLibraryDragData(e: React.DragEvent, asset: LibraryAsset) {
  e.dataTransfer.setData(LIBRARY_MIME, asset.id);
  e.dataTransfer.effectAllowed = "copy";
  inFlightLibrary = asset;
  setRefDragData(e, refFromLibrary(asset));
}

export function draggingLibrary(): LibraryAsset | null {
  return inFlightLibrary;
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
 * `data-drag-omit` (badges riding on the picture). Live `<video>`/`<canvas>`
 * content is baked into the clone (clones of those paint blank), and
 * hover-revealed controls drop out since the clone is not hovered. The clone
 * lives off-screen just long enough for the browser to snapshot it. */
export function setCardDragImage(e: React.DragEvent, host: HTMLElement) {
  const el = host.querySelector<HTMLElement>("[data-drag-object]") ?? host;
  const rect = el.getBoundingClientRect();
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-drag-omit]").forEach((n) => n.remove());
  // Skip media inside omitted nodes so both lists pair up by index.
  const srcMedia = Array.from(el.querySelectorAll<HTMLElement>("video, canvas")).filter(
    (n) => !n.closest("[data-drag-omit]")
  );
  clone.querySelectorAll<HTMLElement>("video, canvas").forEach((node, i) => {
    const src = srcMedia[i];
    if (!src) return;
    const r = src.getBoundingClientRect();
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
        if (src instanceof HTMLVideoElement) {
          // Match object-cover: scale to fill and center-crop.
          const vw = src.videoWidth || r.width;
          const vh = src.videoHeight || r.height;
          const scale = Math.max(c.width / vw, c.height / vh);
          ctx.drawImage(
            src,
            (c.width - vw * scale) / 2,
            (c.height - vh * scale) / 2,
            vw * scale,
            vh * scale
          );
        } else {
          ctx.drawImage(src as HTMLCanvasElement, 0, 0, c.width, c.height);
        }
      } catch {
        // A frame that cannot be painted just leaves that slot blank.
      }
    }
    node.replaceWith(c);
  });
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
export function setObjectDragImage(e: React.DragEvent) {
  const host = e.currentTarget as HTMLElement;
  const el = host.querySelector<HTMLElement>("[data-drag-object]") ?? host;
  const rect = el.getBoundingClientRect();

  const blank = document.createElement("canvas");
  blank.width = blank.height = 1;
  blank.style.cssText = "position:absolute;top:-1000px;left:-1000px;";
  document.body.appendChild(blank);
  e.dataTransfer.setDragImage(blank, 0, 0);
  setTimeout(() => blank.remove(), 0);

  // Hold the object where the pointer grabbed it; a grab outside the object
  // (on the card around it) holds the nearest edge.
  const ox = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
  const oy = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);

  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;left:0;top:0;z-index:1000;pointer-events:none;will-change:transform;";
  const object = el.cloneNode(true) as HTMLElement;
  object.style.width = `${rect.width}px`;
  object.style.height = `${rect.height}px`;
  object.style.margin = "0";
  object.style.opacity = "0.85";
  object.style.transition = "opacity 150ms ease, transform 150ms ease";
  object.style.transformOrigin = `${ox}px ${oy}px`;
  root.appendChild(object);
  document.body.appendChild(root);

  const position = (x: number, y: number) => {
    root.style.transform = `translate(${x - ox}px, ${y - oy}px)`;
  };
  position(e.clientX, e.clientY);

  const onOver = (ev: DragEvent) => {
    position(ev.clientX, ev.clientY);
    const handedOver = !!(ev.target as Element | null)?.closest?.("[data-segment-drop]");
    object.style.opacity = handedOver ? "0" : "0.85";
    object.style.transform = handedOver ? "scale(0.3)" : "scale(1)";
  };
  const end = () => {
    root.remove();
    document.removeEventListener("dragover", onOver);
    window.removeEventListener("dragend", end, true);
    window.removeEventListener("drop", end, true);
  };
  document.addEventListener("dragover", onOver);
  window.addEventListener("dragend", end, true);
  window.addEventListener("drop", end, true);
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
  inFlightLibrary = null;
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
