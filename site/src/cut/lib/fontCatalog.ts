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

/** What kind of face a family is, for picking a stand-in by eye. */
export type FontKind = "serif" | "sans" | "script" | "display" | "mono";

export interface BundledFont {
  id: string;
  label: string;
  kind: FontKind;
  /** A few words on how the face looks, for picking a stand-in by eye. */
  look: string;
  /** The upright weights bundled. */
  weights: number[];
  /** The weights bundled in italic too. */
  italics?: number[];
}

export const GOOGLE_FONTS: BundledFont[] = fonts.flatMap((f) =>
  // A family with no id is a headless stand-in, off the menu.
  f.id
    ? [{ id: f.id, label: f.family, kind: f.kind as FontKind, look: f.look ?? "", weights: f.weights, ...(f.italics ? { italics: f.italics } : {}) }]
    : []
);

export const GOOGLE_FONT_IDS = GOOGLE_FONTS.map((f) => f.id);

/** The system set's kinds and looks (types.ts FONTS). */
const SYSTEM_FACES: Record<string, { kind: FontKind; look: string }> = {
  sf: { kind: "sans", look: "neutral system grotesque" },
  serif: { kind: "serif", look: "book serif (New York)" },
  rounded: { kind: "sans", look: "rounded system" },
  mono: { kind: "mono", look: "monospace" },
  impact: { kind: "sans", look: "heavy condensed (Impact)" },
};

/** The kind of a bundled or system face; undefined for the account's own. */
export function fontKind(id: string): FontKind | undefined {
  return SYSTEM_FACES[id]?.kind ?? GOOGLE_FONTS.find((f) => f.id === id)?.kind;
}

/** How a bundled or system face looks, in a few words. */
export function fontLook(id: string): string | undefined {
  return SYSTEM_FACES[id]?.look ?? GOOGLE_FONTS.find((f) => f.id === id)?.look;
}
