import os from "node:os";
import path from "node:path";

/**
 * Where Cut keeps its projects/ and library/ folders — the user's Movies
 * folder, where Apple says user media belongs and where Finder and other apps
 * can reach it. The packaged engine (DONKEY_CUT_ENGINE) uses DonkeyCut; the
 * dev server uses DonkeyCutDev, so dev experiments stay clear of real
 * projects. DONKEY_CUT_DATA_DIR overrides both.
 */
export function cutDataRoot(): string {
  if (process.env.DONKEY_CUT_DATA_DIR) return process.env.DONKEY_CUT_DATA_DIR;
  const dir = process.env.DONKEY_CUT_ENGINE ? "DonkeyCut" : "DonkeyCutDev";
  return path.join(os.homedir(), "Movies", dir);
}
