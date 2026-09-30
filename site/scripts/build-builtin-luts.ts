// Builds the built-in Cut LUTs from the RawTherapee Film Simulation
// Collection (CC BY-SA 4.0, https://rawtherapee.com/shared/HaldCLUT.zip):
// each picked Hald CLUT (level 12, a 144³ table in a 1728² PNG) is resampled
// to a 33³ .cube under public/cut/luts/, and the typed manifest the editor
// imports is written beside the other generated catalogs. The looks are named
// by what they do; the film stock each one approximates stays out of the
// product.
//
//   cd site && ./node_modules/.bin/bun scripts/build-builtin-luts.ts <path to the unzipped HaldCLUT folder>
//
// A LUT's id is its content key, so a saved grade names the exact bytes it
// was made with: changing a shipped file breaks every grade that wears it.
// Add new looks; leave the shipped files as they are.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import { contentKey } from "../src/cut/lib/contentKey";

type Group = "color" | "bw";

/** The picks: source file (relative to the HaldCLUT folder) → shipped look. */
const PICKS: { src: string; id: string; label: string; group: Group; look: string }[] = [
  { src: "Color/Kodak/Kodak Portra 400 2.png", id: "portrait", label: "Portrait", group: "color", look: "warm, glowing skin, a touch brighter; flattering on people" },
  { src: "Color/Kodak/Kodak Portra 160 NC 2.png", id: "natural", label: "Natural", group: "color", look: "gently warm, true-to-life color, clean whites" },
  { src: "Color/Fuji/Fuji 160C 1 -.png", id: "airy", label: "Airy", group: "color", look: "bright and light, lifted midtones, warm with a little more color" },
  { src: "Color/Fuji/Fuji Velvia 100 Generic.png", id: "vivid", label: "Vivid", group: "color", look: "saturated, warm slide-film color with strong contrast" },
  { src: "Color/Kodak/Kodak Kodachrome 64.png", id: "heritage", label: "Heritage", group: "color", look: "rich reds, restrained greens, crisp whites; classic slide film" },
  { src: "Color/Fuji/Fuji Provia 100F.png", id: "crisp", label: "Crisp", group: "color", look: "neutral color, deeper midtones, clean whites" },
  { src: "Color/Kodak/Kodak Ektachrome 100 VS.png", id: "pop", label: "Pop", group: "color", look: "saturated and dense, deep reds, darker midtones" },
  { src: "Color/Fuji/Fuji Superia 400 2.png", id: "street", label: "Street", group: "color", look: "warm, punchy everyday film color, bright whites" },
  { src: "Color/Agfa/Agfa Vista 200.png", id: "summer", label: "Summer", group: "color", look: "hot reds and magentas, saturated, darker midtones" },
  { src: "Color/Fuji/Fuji Superia 200 XPRO.png", id: "cross-process", label: "Cross Process", group: "color", look: "strong cyan-blue cast, saturated; surreal" },
  { src: "Color/Polaroid/Polaroid 669 3.png", id: "snapshot", label: "Snapshot", group: "color", look: "faded instant film: lifted blacks, muted, cool-green shadows" },
  { src: "Color/Polaroid/Polaroid 690 Warm 3.png", id: "warm-fade", label: "Warm Fade", group: "color", look: "warm, lifted blacks, bright highlights; sunny faded film" },
  { src: "Color/Fuji/Fuji FP-100c 3.png", id: "nostalgic", label: "Nostalgic", group: "color", look: "muted and softly faded, slightly cooler; old prints" },
  { src: "Color/Lomography/Lomography Redscale 100.png", id: "dusty", label: "Dusty", group: "color", look: "dark, dense amber-brown, muted greens" },
  { src: "Black-and-White/Kodak/Kodak TRI-X 400 2.png", id: "press", label: "Press", group: "bw", look: "black and white, even tones, bright whites" },
  { src: "Black-and-White/Ilford/Ilford HP5 Plus 400.png", id: "documentary", label: "Documentary", group: "bw", look: "black and white, dark and contrasty" },
  { src: "Black-and-White/Kodak/Kodak HIE (HS Infra).png", id: "infrared", label: "Infrared", group: "bw", look: "black and white, very bright, glowing highlights and foliage" },
  { src: "Black-and-White/Rollei/Rollei Retro 80s.png", id: "retro-mono", label: "Retro Mono", group: "bw", look: "black and white, hard contrast, deep blacks" },
];

const SIZE = 33;
const OUT_DIR = path.join(import.meta.dir, "../public/cut/luts");
const MANIFEST = path.join(import.meta.dir, "../src/cut/lib/builtinLutManifest.ts");
const CREDIT =
  "Derived from the RawTherapee Film Simulation Collection by Pat David, Pavlov Dmitry and Michael Ezra, licensed CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Resampled to 33 points by Donkey Cut; shared under the same license.";

/** A Hald CLUT's pixels as its table: level L holds L² points per axis, red
 * fastest, one pixel per point in reading order. */
async function readHald(file: string): Promise<{ n: number; px: Uint8Array }> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const level = Math.round(Math.cbrt(info.width));
  if (level ** 3 !== info.width || info.width !== info.height) throw new Error(`${file} is not a square Hald CLUT.`);
  return { n: level * level, px: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** The table at one 0..1 input, trilinear between its points. */
function sample(n: number, px: Uint8Array, r: number, g: number, b: number): [number, number, number] {
  const at = (v: number) => {
    const x = v * (n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    return [i, x - i] as const;
  };
  const [r0, dr] = at(r);
  const [g0, dg] = at(g);
  const [b0, db] = at(b);
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 8; k++) {
    const ri = r0 + (k & 1);
    const gi = g0 + ((k >> 1) & 1);
    const bi = b0 + ((k >> 2) & 1);
    const w = (k & 1 ? dr : 1 - dr) * ((k >> 1) & 1 ? dg : 1 - dg) * ((k >> 2) & 1 ? db : 1 - db);
    const o = ((bi * n + gi) * n + ri) * 3;
    out[0] += w * px[o];
    out[1] += w * px[o + 1];
    out[2] += w * px[o + 2];
  }
  return [out[0] / 255, out[1] / 255, out[2] / 255];
}

const fixed = (v: number) => (Math.round(Math.min(1, Math.max(0, v)) * 1e4) / 1e4).toString();

async function build(root: string) {
  await mkdir(OUT_DIR, { recursive: true });
  const entries: { id: string; label: string; group: Group; look: string; file: string; key: string }[] = [];
  for (const pick of PICKS) {
    const { n, px } = await readHald(path.join(root, pick.src));
    const lines = [`TITLE "${pick.label}"`, `# ${CREDIT}`, `LUT_3D_SIZE ${SIZE}`];
    for (let b = 0; b < SIZE; b++)
      for (let g = 0; g < SIZE; g++)
        for (let r = 0; r < SIZE; r++) {
          const [R, G, B] = sample(n, px, r / (SIZE - 1), g / (SIZE - 1), b / (SIZE - 1));
          lines.push(`${fixed(R)} ${fixed(G)} ${fixed(B)}`);
        }
    const text = lines.join("\n") + "\n";
    const bytes = new TextEncoder().encode(text);
    const name = `${pick.id}.cube`;
    await writeFile(path.join(OUT_DIR, name), bytes);
    entries.push({ id: pick.id, label: pick.label, group: pick.group, look: pick.look, file: `/cut/luts/${name}`, key: await contentKey(bytes.buffer) });
    console.log(`${name}  ${(bytes.byteLength / 1024).toFixed(0)} KB`);
  }
  await writeFile(path.join(OUT_DIR, "LICENSE.txt"), `${CREDIT}\n`);
  await writeFile(
    MANIFEST,
    `// Generated by scripts/build-builtin-luts.ts — do not edit by hand.\n` +
      `import type { BuiltinLut } from "./builtinLuts";\n\n` +
      `export const BUILTIN_LUT_MANIFEST: BuiltinLut[] = [\n${entries.map((e) => `  ${JSON.stringify(e)},`).join("\n")}\n];\n`
  );
}

const root = process.argv[2];
if (!root) throw new Error("Pass the unzipped HaldCLUT folder.");
await build(path.resolve(root));
