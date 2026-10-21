/**
 * The bundled font families, named once in fonts.json.
 *
 * `googleFonts.ts` registers this list for the page, and the assistant's
 * catalog builds its font sentence from it, so the menu the user sees and the
 * ids the model is taught can't drift apart. A label is the family's own name,
 * the one the page and the headless renderer declare it under. The
 * weights are the faces bundled, so a font suggestion only offers those.
 * Framework-free on purpose: the server imports it too.
 */

import fonts from "./fonts.json";

export interface BundledFont {
  id: string;
  label: string;
  /** The upright weights bundled. */
  weights: number[];
  /** The weights bundled in italic too. */
  italics?: number[];
}

export const GOOGLE_FONTS: BundledFont[] = fonts.flatMap((f) =>
  // A family with no id is a headless stand-in, off the menu.
  f.id ? [{ id: f.id, label: f.family, weights: f.weights, ...(f.italics ? { italics: f.italics } : {}) }] : []
);

export const GOOGLE_FONT_IDS = GOOGLE_FONTS.map((f) => f.id);
