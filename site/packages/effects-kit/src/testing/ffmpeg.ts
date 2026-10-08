import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The ffmpeg the recipe tests render with: the app's bundled build on a Mac
// checkout, and the one on PATH in CI, which installs ffmpeg itself.
const BUNDLED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../vendor/donkey-tools/ffmpeg");

export const TEST_FFMPEG = existsSync(BUNDLED) ? BUNDLED : "ffmpeg";
