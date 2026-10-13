/**
 * The LUTs every account has: film looks shipped with the site as `.cube`
 * files under public/cut/luts/, built by scripts/build-builtin-luts.ts from
 * the RawTherapee Film Simulation Collection (CC BY-SA 4.0).
 *
 * A built-in LUT is keyed by its bytes the way a Library LUT is, so a grade
 * names one as `lut:<key>` and every renderer reads it through the same
 * loader. A file on the shelf with the same bytes is the same LUT.
 */

import { BUILTIN_LUT_MANIFEST } from "./builtinLutManifest";

export interface BuiltinLut {
  id: string;
  label: string;
  group: "color" | "bw";
  /** What the look does to a picture, measured off test frames. */
  look: string;
  /** Site-relative path of the .cube. */
  file: string;
  /** Content key of the file's bytes. */
  key: string;
  /** Keys of earlier builds of this look; a grade naming one draws this file. */
  replaces?: string[];
}

export const BUILTIN_LUTS: readonly BuiltinLut[] = BUILTIN_LUT_MANIFEST;

const byKey = new Map(BUILTIN_LUTS.flatMap((l) => [l.key, ...(l.replaces ?? [])].map((k) => [k, l] as const)));

/** One line per built-in LUT, for the chat's tool and prompt text. */
export const builtinLutCatalogText = (): string => BUILTIN_LUTS.map((l) => `${l.label} (${l.look})`).join("; ");

/** The built-in LUT with this content key, or the one that replaced it. */
export const builtinLutByKey = (key: string): BuiltinLut | undefined => byKey.get(key);
