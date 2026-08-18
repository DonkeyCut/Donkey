"use client";

/**
 * Library items a document links to instead of copying — the whole feature,
 * kinds included.
 *
 * `registry.ts` holds the mechanism and `fonts.ts` (and any kind added later)
 * registers itself against it. Importing this folder is what pulls those
 * registrations in, so everything reads the same complete set of kinds: ask the
 * registry directly and it answers for whichever kinds happened to be loaded,
 * which is how a project moves to the cloud leaving one of them behind.
 *
 * A new linked kind is one module beside this one and one line below.
 */

import "./fonts";

export * from "./registry";
export { libraryFontId, listLibraryFonts, uploadLibraryFont } from "./fonts";
