// Stage what smooth slow motion runs on in the tab: the RIFE frame
// interpolation model and the ONNX Runtime WebGPU build that executes it.
// Both are served from public/ so the page fetches nothing from a third
// party at run time.
//
// The model is Practical-RIFE 4.25 (MIT), in the ONNX export the vs-mlrt
// project publishes as a 7z archive. The archive is fetched once, checked
// against its pinned digest, and the fp32 graph inside it is unpacked here.
// The runtime's wasm pair is copied from node_modules on install; it is
// ~28MB, so it is staged like the MediaPipe runtime is, never committed.
//
// Files already staged are kept, so a re-install is free and an offline one
// keeps working. Runs from postinstall. A model that cannot be staged fails
// the install: the page picks the network whenever the machine has WebGPU,
// and a build shipped without the file would fail every smoothed export
// instead.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const MODEL = {
  url: "https://github.com/AmusementClub/vs-mlrt/releases/download/external-models/rife_v4.25.7z",
  archiveSha256: "172fe975c1775134bb87108e4ec6d1a89e861cc5d3be2ac23bf08afe5ed626b8",
  /** The member to unpack: the fp32 graph that takes its own padding. */
  member: "rife/rife_v4.25.onnx",
  sha256: "084f56a0c1e49f404d7a0a171b62a5d49078efdb02fea14d969069e604c60fe9",
  /** Keep in step with frameSynth.ts, which fetches this path. */
  dest: path.join(root, "public", "models", "rife_v4.25.onnx"),
};

const RUNTIME = {
  src: path.join(root, "node_modules", "onnxruntime-web", "dist"),
  /** Keep in step with frameSynth.ts, which points the runtime here. */
  dest: path.join(root, "public", "ort"),
  files: ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"],
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function stageModel() {
  if (existsSync(MODEL.dest) && sha256(readFileSync(MODEL.dest)) === MODEL.sha256) return;
  const res = await fetch(MODEL.url);
  if (!res.ok) throw new Error(`${MODEL.url}: HTTP ${res.status}`);
  const archive = new Uint8Array(await res.arrayBuffer());
  const got = sha256(archive);
  if (got !== MODEL.archiveSha256)
    throw new Error(`${MODEL.url}: digest ${got}, expected ${MODEL.archiveSha256}`);
  const { default: SevenZip } = await import("7z-wasm");
  const sz = await SevenZip({ print: () => {}, printErr: () => {} });
  const name = "rife.7z";
  const stream = sz.FS.open(name, "w+");
  sz.FS.write(stream, archive, 0, archive.length);
  sz.FS.close(stream);
  sz.callMain(["x", name, MODEL.member, "-y"]);
  const model = sz.FS.readFile(MODEL.member);
  const modelGot = sha256(model);
  if (modelGot !== MODEL.sha256)
    throw new Error(`${MODEL.member}: digest ${modelGot}, expected ${MODEL.sha256}`);
  mkdirSync(path.dirname(MODEL.dest), { recursive: true });
  writeFileSync(MODEL.dest, model);
}

function stageRuntime() {
  if (!existsSync(RUNTIME.src)) {
    console.warn("stage-frame-synth: onnxruntime-web not installed; skipping runtime");
    return;
  }
  mkdirSync(RUNTIME.dest, { recursive: true });
  for (const f of RUNTIME.files) copyFileSync(path.join(RUNTIME.src, f), path.join(RUNTIME.dest, f));
}

stageRuntime();
try {
  await stageModel();
} catch (err) {
  console.error(`stage-frame-synth: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
