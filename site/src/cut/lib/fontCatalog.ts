/**
 * The bundled font families, named once.
 *
 * `googleFonts.ts` registers this list for the page, and the assistant's
 * catalog builds its font sentence from it, so the menu the user sees and the
 * ids the model is taught can't drift apart. A label is the family's own name,
 * the one its stylesheet and the headless renderer declare it under.
 * Framework-free on purpose: the server imports it too.
 */

export interface BundledFont {
  id: string;
  label: string;
}

export const GOOGLE_FONTS: BundledFont[] = [
  { id: "inter", label: "Inter" },
  { id: "montserrat", label: "Montserrat" },
  { id: "poppins", label: "Poppins" },
  { id: "oswald", label: "Oswald" },
  { id: "space-grotesk", label: "Space Grotesk" },
  { id: "playfair", label: "Playfair Display" },
  { id: "caveat", label: "Caveat" },
  { id: "bebas", label: "Bebas Neue" },
  { id: "anton", label: "Anton" },
  { id: "archivo-black", label: "Archivo Black" },
  { id: "bangers", label: "Bangers" },
  { id: "lobster", label: "Lobster" },
  { id: "pacifico", label: "Pacifico" },
  { id: "permanent-marker", label: "Permanent Marker" },
  { id: "dm-serif", label: "DM Serif Display" },
  { id: "amatic", label: "Amatic SC" },
  { id: "dseg14", label: "DSEG14 Classic" },
];

export const GOOGLE_FONT_IDS = GOOGLE_FONTS.map((f) => f.id);
