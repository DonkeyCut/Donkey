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

/** Asset ids whose FontFace is loaded (or loading) in this page. */
const loaded = new Map<string, Promise<void>>();

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
    const face = new FontFace(family, await res.arrayBuffer());
    await face.load();
    document.fonts.add(face);
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
 * unregister deleted ones. The editor calls this whenever assets change. */
export function syncFontAssets(assets: MediaAsset[]): void {
  const fonts = assets.filter((a) => a.type === "font");
  for (const a of fonts) void registerFontAsset(a);
  const live = new Set(fonts.map((a) => a.id));
  const stale = [...loaded.keys()].filter((id) => !live.has(id));
  if (stale.length) {
    for (const id of stale) loaded.delete(id);
    unregisterFonts(stale.map(uploadedFontId));
  }
}
