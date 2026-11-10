"use client";

/**
 * ⌘V of anything a panel offers: the tile's + button, for a ref that arrived
 * as a mention token on the system clipboard. A copied media tile, library
 * card, stock sound, sticker, effect, shape or template lands under the
 * indicator the way its tile's + button lands it; a transition lands the way
 * a dropped one does, through the timeline's own landing.
 */

import { CATALOG_PREFIX, type AssetRef } from "./assetRef";
import { isLinkedAssetType } from "./types";
import {
  addProjectTemplateToTimeline,
  addTemplateToProject,
  importLibraryAsset,
  type LibraryData,
} from "./library";
import { isLottieAsset } from "./lottieAssets";
import { importImage, importStockAudio, importStockVideo } from "./media";
import { useEditor } from "./store";
import { landTransitionAt } from "./timelineDrop";
import type { AssetType, MediaAsset, ShapeKind, TransitionStyle } from "./types";
import type { EffectId } from "@donkeycut/effects-kit";

/** A project asset lands as the tile's + button lands it: a sticker as a
 * sticker element, footage and stills on the first video row with room, a
 * sound on the first audio lane with room. */
function placeAsset(asset: MediaAsset, at: number): void {
  const s = useEditor.getState();
  if (isLinkedAssetType(asset.type)) return;
  if (asset.origin === "sticker") {
    s.addSticker({ assetId: asset.id, ...(isLottieAsset(asset) ? { lottie: true } : {}), at });
    return;
  }
  s.addAssetAtPlayhead(asset.id, at);
}

/** The kind of media a ref stands for, read off the ref and the shelf
 * listing without importing anything. Null for what is no file: a timeline
 * entity, a catalog pick, a font or a LUT. */
export function mediaTypeOfRef(ref: AssetRef, library: LibraryData): AssetType | null {
  switch (ref.scope) {
    case "project": {
      const type = useEditor.getState().assets.find((a) => a.id === ref.id)?.type;
      return type && !isLinkedAssetType(type) ? type : null;
    }
    case "library": {
      const type = library.assets.find((a) => a.id === ref.id)?.type;
      return type && !isLinkedAssetType(type) ? type : null;
    }
    case "stock":
      return ref.kind === "audio" || ref.kind === "video" || ref.kind === "image" ? ref.kind : null;
    default:
      return null;
  }
}

/** The project file a media ref stands for: a project asset as it is, a
 * library or stock file copied into the project first. Null when the ref
 * names no file. */
export async function mediaOfRef(
  ref: AssetRef,
  ctx: { projectId: string; library: LibraryData }
): Promise<MediaAsset | null> {
  const { projectId, library } = ctx;
  switch (ref.scope) {
    case "project":
      return useEditor.getState().assets.find((a) => a.id === ref.id) ?? null;
    case "library": {
      const lib = library.assets.find((a) => a.id === ref.id);
      if (!lib || isLinkedAssetType(lib.type)) {
        return null;
      }
      return importLibraryAsset(projectId, lib);
    }
    case "stock":
      return ref.kind === "audio"
        ? importStockAudio(projectId, { url: ref.url, name: ref.name, duration: ref.duration })
        : ref.kind === "video"
          ? importStockVideo(projectId, {
              url: ref.url,
              name: ref.name,
              duration: ref.duration,
              width: ref.width,
              height: ref.height,
            })
          : ref.kind === "image"
            ? importImage(projectId, { url: ref.url, name: ref.name })
            : null;
    default:
      return null;
  }
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
    case "library":
    case "stock": {
      const asset = await mediaOfRef(ref, { projectId, library });
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
          return landTransitionAt(at, pick as TransitionStyle);
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
