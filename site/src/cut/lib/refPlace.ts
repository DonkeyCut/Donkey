"use client";

/**
 * ⌘V of anything a panel offers: the tile's + button, for a ref that arrived
 * as a mention token on the system clipboard. A copied media tile, library
 * card, stock sound, sticker, effect, shape, transition or template lands
 * under the indicator the way its tile's + button lands it.
 */

import { CATALOG_PREFIX, type AssetRef } from "./assetRef";
import {
  addProjectTemplateToTimeline,
  addTemplateToProject,
  importLibraryAsset,
  type LibraryData,
} from "./library";
import { isLottieAsset } from "./lottieAssets";
import { importImage, importStockAudio, importStockVideo } from "./media";
import { clipLen, useEditor } from "./store";
import {
  transitionDefaultSeconds,
  XBAR_MAGNET_PX,
  type MediaAsset,
  type ShapeKind,
  type TransitionStyle,
} from "./types";
import type { EffectId } from "@donkeycut/effects-kit";

/** A project asset lands as the tile's + button lands it: a sticker as a
 * sticker element, footage and stills on the first video row with room, a
 * sound on the first audio lane with room. */
function placeAsset(asset: MediaAsset, at: number): void {
  const s = useEditor.getState();
  if (asset.type === "font") return;
  if (asset.origin === "sticker") {
    s.addSticker({ assetId: asset.id, ...(isLottieAsset(asset) ? { lottie: true } : {}), at });
    return;
  }
  s.addAssetAtPlayhead(asset.id, at);
}

/** A transition takes the clip tail within the same reach a dragged bar
 * snaps by, replacing whatever plays there; with no edge in reach it parks
 * at the indicator, the way a bar dropped in open row does. */
function placeTransition(style: TransitionStyle, at: number): void {
  const s = useEditor.getState();
  const reach = XBAR_MAGNET_PX / s.pxPerSec;
  let best: { id: string; gap: number } | null = null;
  for (const c of s.clips) {
    const gap = Math.abs(c.start + clipLen(c) - at);
    if (gap <= reach && (!best || gap < best.gap)) best = { id: c.id, gap };
  }
  const seconds = transitionDefaultSeconds(style);
  if (best) {
    s.setClipTransition(best.id, seconds, style);
    return;
  }
  const id = s.addTransition({ start: at, seconds, style });
  s.select({ kind: "transition", id });
}

/**
 * Land one ref at `at`. True when the ref named something a panel places;
 * false for a live timeline entity or a chat attachment, which no tile
 * offers. Imports (library copies, stock downloads) run behind the editor and
 * place when they settle.
 */
export async function placeRefAtPlayhead(
  ref: AssetRef,
  ctx: { projectId: string; library: LibraryData; at: number }
): Promise<boolean> {
  const { projectId, library, at } = ctx;
  const placeWhenReady = (asset: MediaAsset) => {
    // The import outlived a project switch: its bytes belong to the project
    // it was prepared against.
    if (useEditor.getState().projectId !== projectId) return;
    placeAsset(asset, at);
  };
  switch (ref.scope) {
    case "project": {
      const asset = useEditor.getState().assets.find((a) => a.id === ref.id);
      if (!asset) return false;
      placeAsset(asset, at);
      return true;
    }
    case "library": {
      const lib = library.assets.find((a) => a.id === ref.id);
      if (!lib || lib.type === "font") return false;
      placeWhenReady(await importLibraryAsset(projectId, lib));
      return true;
    }
    case "stock": {
      const asset =
        ref.kind === "audio"
          ? await importStockAudio(projectId, { url: ref.url, name: ref.name, duration: ref.duration })
          : ref.kind === "video"
            ? await importStockVideo(projectId, {
                url: ref.url,
                name: ref.name,
                duration: ref.duration,
                width: ref.width,
                height: ref.height,
              })
            : ref.kind === "image"
              ? await importImage(projectId, { url: ref.url, name: ref.name })
              : null;
      if (!asset) return false;
      placeWhenReady(asset);
      return true;
    }
    case "entity": {
      if (!ref.id.startsWith(CATALOG_PREFIX)) return false;
      const [kind, ...rest] = ref.id.slice(CATALOG_PREFIX.length).split(":");
      const pick = rest.join(":");
      const s = useEditor.getState();
      switch (kind) {
        case "effect":
          s.addEffect(pick as EffectId, { at });
          return true;
        case "shape":
          s.addShape(pick as ShapeKind, { at });
          return true;
        case "transition":
          placeTransition(pick as TransitionStyle, at);
          return true;
        case "template": {
          const own = s.templates.find((t) => t.id === pick);
          if (own) {
            await addProjectTemplateToTimeline(projectId, own, at);
            return true;
          }
          const shelf = library.templates.find((t) => t.id === pick);
          if (!shelf) return false;
          await addTemplateToProject(projectId, shelf, at);
          return true;
        }
        default:
          return false;
      }
    }
    default:
      return false;
  }
}
