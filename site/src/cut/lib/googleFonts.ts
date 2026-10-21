"use client";

/**
 * The bundled Google font families, self-hosted from the @fontsource packages.
 * scripts/stage-cut-fonts.mjs copies every face of each family in fonts.json
 * into /cut-fonts, one file per unicode subset, so nothing fetches Google at
 * build or run time and a rasterize is deterministic offline. Each family is
 * declared under its own name, the name the catalog labels it with and the
 * headless renderer loads it under. Importing this module (the editor root
 * does) declares every face and registers every family into the shared font
 * registry.
 */

import manifest from "../../../public/cut-fonts/manifest.json";
import { GOOGLE_FONTS } from "./fontCatalog";
import { registerFonts } from "./types";

/** One staged family as the manifest lists it. */
interface StagedFamily {
  /** Absent on the headless stand-ins, which the page never draws. */
  id?: string;
  family: string;
  faces: { file: string; weight: number; style: string; subset: string }[];
  /** Each subset's unicode-range; a single-subset family has none. */
  ranges: Partial<Record<string, string>>;
}

/** Where the staged files are served. */
const FONT_DIR = "/cut-fonts/";

/** Declare one FontFace per staged face, unloaded. The browser fetches a
 * face's file the first time text in its unicode range is drawn or
 * `document.fonts.load` asks for it, as it does for a CSS @font-face rule,
 * so a family nobody uses costs nothing. */
function declareFaces(): void {
  // Server rendering has no document; the browser's import declares them.
  if (typeof document === "undefined") {
    return;
  }

  for (const entry of manifest as StagedFamily[]) {
    if (!entry.id) {
      continue;
    }

    for (const face of entry.faces) {
      const range = entry.ranges[face.subset];
      const font = new FontFace(entry.family, `url(${FONT_DIR}${face.file}) format("woff2")`, {
        weight: String(face.weight),
        style: face.style,
        display: "swap",
        ...(range ? { unicodeRange: range } : {}),
      });
      document.fonts.add(font);
    }
  }
}

declareFaces();
registerFonts(GOOGLE_FONTS.map((f) => ({ id: f.id, label: f.label, stack: `"${f.label}"` })));
