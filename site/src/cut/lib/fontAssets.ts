"use client";

/**
 * Font assets: a .ttf/.otf living in a project's media/ folder as a
 * type-"font" asset. This module turns those bytes into live FontFaces and
 * registry entries so the font menu, the DOM preview, and the canvas painters
 * all resolve them. Family names key on the asset id, which is stable across
 * sessions and residencies. Projects no longer take new font files; what is
 * here keeps the ones already saved rendering.
 */

import {
  registerFonts,
  unregisterFonts,
  uploadedFontId,
  type MediaAsset,
} from "./types";

/** Asset ids whose face is loaded (or loading) in this process. */
const loaded = new Map<string, Promise<void>>();

/**
 * How a font's bytes become a family the painters can draw.
 *
 * The page adds a FontFace to the document. A process with no document
 * installs its own — the server canvas's font library — so a title set in a
 * project's uploaded font renders the same in a job as in the tab.
 */
export type FontInstaller = (family: string, bytes: ArrayBuffer) => Promise<void>;

let installFace: FontInstaller = async (family, bytes) => {
  const face = new FontFace(family, bytes);
  await face.load();
  document.fonts.add(face);
};

export function setFontInstaller(install: FontInstaller): void {
  installFace = install;
}

/** Install one face through whichever seam this process filled. Font bytes
 * reach a family exactly one way, whether they came off a project's media
 * folder or the account's Library shelf. Throws on bytes that are not a font,
 * which is what makes it double as the upload's validity check. */
export function installFontFace(family: string, bytes: ArrayBuffer): Promise<void> {
  return installFace(family, bytes);
}

/** A display label from the uploaded file's name, extension dropped. */
const fontLabel = (name: string) => name.replace(/\.(ttf|otf|woff2?|TTF|OTF)$/, "") || "Custom font";

/** Register one font asset: fetch its bytes, add the FontFace, and list it in
 * the font registry. Safe to call repeatedly. */
export function registerFontAsset(asset: MediaAsset): Promise<void> {
  let hit = loaded.get(asset.id);
  if (hit) return hit;
  const family = `uf-${asset.id}`;
  hit = (async () => {
    const res = await fetch(asset.url);
    if (!res.ok) throw new Error("font fetch failed");
    await installFace(family, await res.arrayBuffer());
    registerFonts([
      { id: uploadedFontId(asset.id), label: fontLabel(asset.name), stack: `"${family}"` },
    ]);
  })().catch(() => {
    // A gone or corrupt file: drop the marker so a later pass can retry.
    loaded.delete(asset.id);
  });
  loaded.set(asset.id, hit);
  return hit;
}

/** Reconcile the registry with the project's font assets: register new ones,
 * unregister deleted ones. The editor calls this whenever assets change; a
 * headless run awaits it before drawing anything. */
export function syncFontAssets(assets: MediaAsset[]): Promise<void> {
  const fonts = assets.filter((a) => a.type === "font");
  const live = new Set(fonts.map((a) => a.id));
  const stale = [...loaded.keys()].filter((id) => !live.has(id));
  if (stale.length) {
    for (const id of stale) loaded.delete(id);
    unregisterFonts(stale.map(uploadedFontId));
  }
  return Promise.all(fonts.map(registerFontAsset)).then(() => {});
}
