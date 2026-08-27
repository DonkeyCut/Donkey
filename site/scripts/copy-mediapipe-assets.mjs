// Stage the MediaPipe vision runtime into public/ so segmentation runs
// self-hosted (no runtime Google fetch). The wasm pair is ~12MB, so it is
// copied from node_modules on install rather than committed; the
// person-segmentation and tap-to-select models are committed beside it.
// Runs from postinstall.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const dest = path.join(root, "public", "mediapipe", "wasm");

// Modern browsers all take the SIMD build; the nosimd/module variants stay out.
const files = ["vision_wasm_internal.js", "vision_wasm_internal.wasm"];

if (!existsSync(src)) {
  console.warn("copy-mediapipe-assets: @mediapipe/tasks-vision not installed; skipping");
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
for (const f of files) copyFileSync(path.join(src, f), path.join(dest, f));
