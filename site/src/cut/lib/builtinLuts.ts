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
  /** Site-relative path of the .cube. */
  file: string;
  /** Content key of the file's bytes. */
  key: string;
}

export const BUILTIN_LUTS: readonly BuiltinLut[] = BUILTIN_LUT_MANIFEST;

const byKey = new Map(BUILTIN_LUTS.map((l) => [l.key, l]));

/** The built-in LUT with this content key. */
export const builtinLutByKey = (key: string): BuiltinLut | undefined => byKey.get(key);
