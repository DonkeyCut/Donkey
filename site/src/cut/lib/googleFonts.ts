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
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/montserrat/400.css";
import "@fontsource/montserrat/500.css";
import "@fontsource/montserrat/600.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/montserrat/800.css";
import "@fontsource/montserrat/900.css";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/poppins/800.css";
import "@fontsource/poppins/900.css";
import "@fontsource/oswald/400.css";
import "@fontsource/oswald/500.css";
import "@fontsource/oswald/600.css";
import "@fontsource/oswald/700.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/playfair-display/400.css";
import "@fontsource/playfair-display/500.css";
import "@fontsource/playfair-display/600.css";
import "@fontsource/playfair-display/700.css";
import "@fontsource/playfair-display/900.css";
// The italics are the caption emphasis default's face (subtitles.ts).
import "@fontsource/playfair-display/400-italic.css";
import "@fontsource/playfair-display/700-italic.css";
import "@fontsource/playfair-display/900-italic.css";
import "@fontsource/caveat/400.css";
import "@fontsource/caveat/500.css";
import "@fontsource/caveat/600.css";
import "@fontsource/caveat/700.css";
import "@fontsource/bebas-neue/400.css";
import "@fontsource/anton/400.css";
import "@fontsource/archivo-black/400.css";
import "@fontsource/bangers/400.css";
import "@fontsource/lobster/400.css";
import "@fontsource/pacifico/400.css";
import "@fontsource/permanent-marker/400.css";
import "@fontsource/dm-serif-display/400.css";
import "@fontsource/amatic-sc/400.css";
import "@fontsource/amatic-sc/700.css";
// Light and Bold only, so a 400 title matches the thin Light LCD face.
import "@fontsource/dseg14-classic/300.css";
import "@fontsource/dseg14-classic/300-italic.css";
import "@fontsource/dseg14-classic/700.css";
import "@fontsource/dseg14-classic/700-italic.css";
import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "@fontsource/outfit/600.css";
import "@fontsource/outfit/700.css";
import "@fontsource/cinzel/400.css";
import "@fontsource/cinzel/700.css";
import "@fontsource/freckle-face/400.css";
import "@fontsource/orbitron/400.css";
import "@fontsource/orbitron/900.css";
import "@fontsource/chewy/400.css";
import "@fontsource/great-vibes/400.css";
import "@fontsource/rubik-dirt/400.css";
import "@fontsource/fredoka/500.css";
import "@fontsource/fredoka/600.css";
import "@fontsource/fredoka/700.css";
import "@fontsource/oranienbaum/400.css";
import "@fontsource/kaushan-script/400.css";
import "@fontsource/rubik/400.css";
import "@fontsource/rubik/500.css";
import "@fontsource/rubik/700.css";
import "@fontsource/rubik/900.css";
import "@fontsource/jost/400.css";
import "@fontsource/jost/500.css";
import "@fontsource/jost/600.css";
import "@fontsource/jost/700.css";
import "@fontsource/gloria-hallelujah/400.css";
// Black only: the heavy geometric face of a reference's font cycle.
import "@fontsource/prompt/900.css";
import { GOOGLE_FONTS } from "./fontCatalog";
import { registerFonts } from "./types";

registerFonts(GOOGLE_FONTS.map((f) => ({ id: f.id, label: f.label, stack: `"${f.label}"` })));
