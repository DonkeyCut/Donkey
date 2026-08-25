"use client";

/**
 * The account's own typefaces: font files on the Library shelf, turned into
 * families the font menu, the DOM preview and the canvas painters resolve.
 *
 * Fonts are the first of the Library's linked kinds — pointed at by a document
 * rather than copied into it — so everything about identity, placement, and
 * travelling with a project lives in `libraryLinks.ts`. What is here is the
 * font-shaped part: installing bytes as a family, and the ids a title or a
 * caption is set in.
 *
 * A job reads the cloud shelf alone, so a font kept on a device shelf draws in
 * the tab and falls back to the base face in a render.
 */

import { installFontFace } from "../fontAssets";
import { forgetTextWidths } from "../textFit";
import { isFontFile } from "../media";
import { fontsFromArchive, isFontArchive } from "../fontArchive";
import {
  linkId,
  listLinked,
  registerLinkedKind,
  uploadLinkedItem,
  type LinkedItem,
} from "./registry";
import type { ProjectDoc } from "../types";
import { registerFonts, unregisterFonts } from "../types";

const PREFIX = "font";

/** The registry id a shelf font answers to. `fontStack` falls back tolerantly,
 * so a title set in a font that has since been deleted still renders. */
export const libraryFontId = (key: string) => linkId(PREFIX, key);

/** The CSS/skia family name its bytes are installed under. */
const familyOf = (key: string) => `lf-${key}`;

registerLinkedKind({
  prefix: PREFIX,
  type: "font",
  homeFolder: "Fonts",
  matches: isFontFile,
  accept: ".ttf,.otf,.woff,.woff2,.zip,font/ttf,font/otf,font/woff,font/woff2,application/zip",
  unpack: async (file) => (isFontArchive(file) ? await fontsFromArchive(file) : null),
  extract: (doc: ProjectDoc) => {
    const ids: string[] = [];
    for (const o of doc.overlays ?? []) {
      const font = (o as { font?: string }).font;
      if (font?.startsWith(`${PREFIX}:`)) ids.push(font);
    }
    const cues = doc.subtitles?.font;
    if (cues?.startsWith(`${PREFIX}:`)) ids.push(cues);
    return ids;
  },
  use: async (key, label, bytes) => {
    await installFontFace(familyOf(key), bytes);
    registerFonts([{ id: libraryFontId(key), label, stack: `"${familyOf(key)}"` }]);
  },
  drop: (keys) => {
    unregisterFonts(keys.map(libraryFontId));
    forgetTextWidths();
  },
});

/** The account's fonts, one entry per typeface however many shelves hold it. */
export const listLibraryFonts = (): LinkedItem[] => listLinked(PREFIX);

/** Put a font file on the shelf and light it up in the font menu. The file is
 * checked before any bytes move (see `checkFont` in library.ts), so a failure
 * here means nothing landed. */
export const uploadLibraryFont = (file: File): Promise<string> =>
  uploadLinkedItem(PREFIX, file);
