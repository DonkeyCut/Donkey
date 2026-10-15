/**
 * The bundled font families, named once.
 *
 * `googleFonts.ts` registers this list for the page, and the assistant's
 * catalog builds its font sentence from it, so the menu the user sees and the
 * ids the model is taught can't drift apart. A label is the family's own name,
 * the one its stylesheet and the headless renderer declare it under. The
 * weights are the faces bundled, so a font suggestion only offers those.
 * Framework-free on purpose: the server imports it too.
 */

export interface BundledFont {
  id: string;
  label: string;
  /** The upright weights bundled, as googleFonts.ts declares them. */
  weights: number[];
  /** The weights bundled in italic too. */
  italics?: number[];
}

export const GOOGLE_FONTS: BundledFont[] = [
  { id: "inter", label: "Inter", weights: [400, 500, 600, 700] },
  { id: "montserrat", label: "Montserrat", weights: [400, 500, 600, 700, 800, 900] },
  { id: "poppins", label: "Poppins", weights: [400, 500, 600, 700, 800, 900] },
  { id: "oswald", label: "Oswald", weights: [400, 500, 600, 700] },
  { id: "space-grotesk", label: "Space Grotesk", weights: [400, 500, 600, 700] },
  { id: "playfair", label: "Playfair Display", weights: [400, 500, 600, 700, 900], italics: [400, 700, 900] },
  { id: "caveat", label: "Caveat", weights: [400, 500, 600, 700] },
  { id: "bebas", label: "Bebas Neue", weights: [400] },
  { id: "anton", label: "Anton", weights: [400] },
  { id: "archivo-black", label: "Archivo Black", weights: [400] },
  { id: "bangers", label: "Bangers", weights: [400] },
  { id: "lobster", label: "Lobster", weights: [400] },
  { id: "pacifico", label: "Pacifico", weights: [400] },
  { id: "permanent-marker", label: "Permanent Marker", weights: [400] },
  { id: "dm-serif", label: "DM Serif Display", weights: [400] },
  { id: "amatic", label: "Amatic SC", weights: [400, 700] },
  { id: "dseg14", label: "DSEG14 Classic", weights: [300, 700], italics: [300, 700] },
  { id: "outfit", label: "Outfit", weights: [400, 500, 600, 700] },
  { id: "cinzel", label: "Cinzel", weights: [400, 700] },
  { id: "freckle-face", label: "Freckle Face", weights: [400] },
  { id: "orbitron", label: "Orbitron", weights: [400, 900] },
  { id: "chewy", label: "Chewy", weights: [400] },
  { id: "great-vibes", label: "Great Vibes", weights: [400] },
  { id: "rubik-dirt", label: "Rubik Dirt", weights: [400] },
  { id: "fredoka", label: "Fredoka", weights: [500, 600, 700] },
  { id: "oranienbaum", label: "Oranienbaum", weights: [400] },
  { id: "kaushan", label: "Kaushan Script", weights: [400] },
  { id: "rubik", label: "Rubik", weights: [400, 500, 700, 900] },
  { id: "jost", label: "Jost", weights: [400, 500, 600, 700] },
  { id: "gloria-hallelujah", label: "Gloria Hallelujah", weights: [400] },
];

export const GOOGLE_FONT_IDS = GOOGLE_FONTS.map((f) => f.id);
