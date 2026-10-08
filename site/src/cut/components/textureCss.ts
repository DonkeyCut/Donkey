/**
 * The kit's text textures and erosion as CSS masks: each tile painted once on
 * a page canvas and handed to the DOM as a data URL, stretched over the box
 * the canvas painter cuts the same tile out of.
 */

import type { CSSProperties } from "react";
import { erodeTile, textureTile, type TextTexture, type TextureSurface } from "@donkeycut/effects-kit";

/** Where the DOM paints texture tiles: a page canvas, made once per texture. */
const DOM_TEXTURE: TextureSurface = {
  owner: {},
  make: (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  },
};
const textureMasks = new Map<TextTexture, CSSProperties>();

/** A texture as one box's CSS mask: the kit's tile of kept ink, stretched
 * over the glyph or word it sits on — the box the canvas cuts the same tile's
 * holes out of. */
export function textureMask(texture: TextTexture): CSSProperties {
  const known = textureMasks.get(texture);
  if (known) {
    return known;
  }
  const url = `url(${textureTile(texture, "keep", DOM_TEXTURE).toDataURL()})`;
  const mask: CSSProperties = {
    maskImage: url,
    WebkitMaskImage: url,
    maskSize: "100% 100%",
    WebkitMaskSize: "100% 100%",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
  };
  textureMasks.set(texture, mask);
  return mask;
}

/** Erosion tiles as data URLs, one per step the kit paints. */
const erodeUrls = new WeakMap<HTMLCanvasElement, string>();

/** A disintegration as the box's CSS mask: the kit's erosion tile of kept
 * ink stretched over the box, the box the canvas cuts the same tile's holes
 * out of. An element mask stays on as a second layer, the two intersected. */
export function erodeMask(erode: number, under: CSSProperties | null | undefined): CSSProperties {
  const tile = erodeTile(erode, "keep", DOM_TEXTURE);
  let url = erodeUrls.get(tile);
  if (!url) {
    url = `url(${tile.toDataURL()})`;
    erodeUrls.set(tile, url);
  }
  const image = under?.maskImage ? `${url}, ${under.maskImage}` : url;
  const size = under?.maskImage ? "100% 100%, 100% 100%" : "100% 100%";
  return {
    ...(under ?? {}),
    maskImage: image,
    WebkitMaskImage: image,
    maskSize: size,
    WebkitMaskSize: size,
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    ...(under?.maskImage ? { maskComposite: "intersect", WebkitMaskComposite: "source-in" } : {}),
  };
}

