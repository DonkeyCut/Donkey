"use client";

/**
 * The bundled Google font families, self-hosted at build time via
 * next/font/google — the loader downloads the files during `next build` and
 * serves them from our origin, so nothing fetches Google at runtime and a
 * rasterize is deterministic offline. Importing this module (the editor root
 * does) registers every family into the shared font registry.
 */

import {
  Anton,
  Archivo_Black,
  Bangers,
  Bebas_Neue,
  Caveat,
  DM_Serif_Display,
  Inter,
  Lobster,
  Montserrat,
  Oswald,
  Pacifico,
  Permanent_Marker,
  Playfair_Display,
  Poppins,
  Space_Grotesk,
} from "next/font/google";
import { GOOGLE_FONTS } from "./fontCatalog";
import { registerFonts } from "./types";

const inter = Inter({ subsets: ["latin"], weight: ["400", "700"], preload: false });
const montserrat = Montserrat({ subsets: ["latin"], weight: ["400", "700"], preload: false });
const poppins = Poppins({ subsets: ["latin"], weight: ["400", "700"], preload: false });
const oswald = Oswald({ subsets: ["latin"], weight: ["400", "700"], preload: false });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], weight: ["400", "700"], preload: false });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["400", "700"], preload: false });
const caveat = Caveat({ subsets: ["latin"], weight: ["400", "700"], preload: false });
const bebas = Bebas_Neue({ subsets: ["latin"], weight: "400", preload: false });
const anton = Anton({ subsets: ["latin"], weight: "400", preload: false });
const archivoBlack = Archivo_Black({ subsets: ["latin"], weight: "400", preload: false });
const bangers = Bangers({ subsets: ["latin"], weight: "400", preload: false });
const lobster = Lobster({ subsets: ["latin"], weight: "400", preload: false });
const pacifico = Pacifico({ subsets: ["latin"], weight: "400", preload: false });
const permanentMarker = Permanent_Marker({ subsets: ["latin"], weight: "400", preload: false });
const dmSerifDisplay = DM_Serif_Display({ subsets: ["latin"], weight: "400", preload: false });

// One stack per bundled id; the list itself lives in fontCatalog.ts, which the
// assistant's catalog reads too.
const STACKS: Record<string, string> = {
  inter: inter.style.fontFamily,
  montserrat: montserrat.style.fontFamily,
  poppins: poppins.style.fontFamily,
  oswald: oswald.style.fontFamily,
  "space-grotesk": spaceGrotesk.style.fontFamily,
  playfair: playfair.style.fontFamily,
  caveat: caveat.style.fontFamily,
  bebas: bebas.style.fontFamily,
  anton: anton.style.fontFamily,
  "archivo-black": archivoBlack.style.fontFamily,
  bangers: bangers.style.fontFamily,
  lobster: lobster.style.fontFamily,
  pacifico: pacifico.style.fontFamily,
  "permanent-marker": permanentMarker.style.fontFamily,
  "dm-serif": dmSerifDisplay.style.fontFamily,
};

registerFonts(GOOGLE_FONTS.map((f) => ({ ...f, stack: STACKS[f.id] })));
