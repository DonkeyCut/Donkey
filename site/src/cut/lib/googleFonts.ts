"use client";

/**
 * The bundled Google font families, self-hosted from the @fontsource packages.
 * Their stylesheets declare one face per unicode subset, served from our
 * origin, so nothing fetches Google at build or run time and a rasterize is
 * deterministic offline. Each family is declared under its own name, the name
 * the catalog labels it with and the headless renderer loads it under.
 * Importing this module (the editor root does) registers every family into the
 * shared font registry.
 */

import "@fontsource/inter/400.css";
import "@fontsource/inter/700.css";
import "@fontsource/montserrat/400.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/700.css";
import "@fontsource/oswald/400.css";
import "@fontsource/oswald/700.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/playfair-display/400.css";
import "@fontsource/playfair-display/700.css";
// The italics are the caption emphasis default's face (subtitles.ts).
import "@fontsource/playfair-display/400-italic.css";
import "@fontsource/playfair-display/700-italic.css";
import "@fontsource/caveat/400.css";
import "@fontsource/caveat/700.css";
import "@fontsource/bebas-neue/400.css";
import "@fontsource/anton/400.css";
import "@fontsource/archivo-black/400.css";
import "@fontsource/bangers/400.css";
import "@fontsource/lobster/400.css";
import "@fontsource/pacifico/400.css";
import "@fontsource/permanent-marker/400.css";
import "@fontsource/dm-serif-display/400.css";
import { GOOGLE_FONTS } from "./fontCatalog";
import { registerFonts } from "./types";

registerFonts(GOOGLE_FONTS.map((f) => ({ ...f, stack: `"${f.label}"` })));
