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

registerFonts([
  { id: "inter", label: "Inter", stack: inter.style.fontFamily },
  { id: "montserrat", label: "Montserrat", stack: montserrat.style.fontFamily },
  { id: "poppins", label: "Poppins", stack: poppins.style.fontFamily },
  { id: "oswald", label: "Oswald", stack: oswald.style.fontFamily },
  { id: "space-grotesk", label: "Space Grotesk", stack: spaceGrotesk.style.fontFamily },
  { id: "playfair", label: "Playfair Display", stack: playfair.style.fontFamily },
  { id: "caveat", label: "Caveat", stack: caveat.style.fontFamily },
  { id: "bebas", label: "Bebas Neue", stack: bebas.style.fontFamily },
  { id: "anton", label: "Anton", stack: anton.style.fontFamily },
  { id: "archivo-black", label: "Archivo Black", stack: archivoBlack.style.fontFamily },
  { id: "bangers", label: "Bangers", stack: bangers.style.fontFamily },
  { id: "lobster", label: "Lobster", stack: lobster.style.fontFamily },
  { id: "pacifico", label: "Pacifico", stack: pacifico.style.fontFamily },
  { id: "permanent-marker", label: "Permanent Marker", stack: permanentMarker.style.fontFamily },
  { id: "dm-serif", label: "DM Serif Display", stack: dmSerifDisplay.style.fontFamily },
]);
