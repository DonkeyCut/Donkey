// Stage the MediaPipe vision runtime into public/ so segmentation and tracking
// run self-hosted (no runtime Google fetch). The wasm pair is ~12MB, so it is
// copied from node_modules on install rather than committed; the
// person-segmentation and tap-to-select models are committed beside it. The
// landmarker models are ~21MB together, so install fetches them once from
// Google's model bucket, pinned by version and checksum.
// Runs from postinstall.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// The tracking models (src/cut/lib/tracking.ts reads them from these paths).
const MODEL_BUCKET = "https://storage.googleapis.com/mediapipe-models";
const models = [
  {
    file: "hand_landmarker.task",
    url: `${MODEL_BUCKET}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
    sha256: "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
  },
  {
    file: "face_landmarker.task",
    url: `${MODEL_BUCKET}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
    sha256: "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
  },
  {
    file: "pose_landmarker_full.task",
    url: `${MODEL_BUCKET}/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
    sha256: "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1",
  },
];

const modelDir = path.join(root, "public", "mediapipe");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const m of models) {
  const out = path.join(modelDir, m.file);

  // A staged model with the pinned checksum is already in place.
  if (existsSync(out) && digest(readFileSync(out)) === m.sha256) continue;
  const res = await fetch(m.url);
  if (!res.ok) throw new Error(`copy-mediapipe-assets: ${m.file} download failed (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (digest(bytes) !== m.sha256) throw new Error(`copy-mediapipe-assets: ${m.file} checksum mismatch`);
  writeFileSync(out, bytes);
}
