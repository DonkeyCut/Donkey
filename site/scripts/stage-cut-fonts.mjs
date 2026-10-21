// Stage the Cut font files into public/ for the page and a headless render.
// The families are listed once, in src/cut/lib/fonts.json. Every subset of
// each weight is copied here from its @fontsource package, and the manifest
// records each face's subset and unicode-range: the page adds one lazy
// FontFace per face (googleFonts.ts), and a render worker hands skia the latin
// files (lib/headless/nodeFonts.ts).
//
// The alias-only families cover the base system set (SF Pro, New York,
// Impact…). Those live on a Mac and nowhere else, so a Linux container would
// draw tofu for the default font; the aliases register a close stand-in under
// each name the CSS stacks ask for.
//
// Runs from postinstall and reads only node_modules, so it needs no network.
// A missing face fails the install: the package versions pin the files.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dest = path.join(root, "public", "cut-fonts");
const require = createRequire(import.meta.url);
const FAMILIES = JSON.parse(readFileSync(path.join(root, "src", "cut", "lib", "fonts.json"), "utf8"));

/** The subset skia draws from; the others only serve the page. */
const SKIA_SUBSET = "latin";

const slug = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** The faces one @fontsource stylesheet declares, one per subset:
 * "inter-cyrillic-400-normal" → { file, subset: "cyrillic", range }. A
 * single-subset family declares no unicode-range, so its face covers all. */
function readFaces(pkgDir, pkg, weight, style) {
  const css = readFileSync(path.join(pkgDir, `${weight}${style === "italic" ? "-italic" : ""}.css`), "utf8");
  const faces = [];
  for (const [, body] of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const file = body.match(/url\(\.\/files\/([^)]+\.woff2)\)/)?.[1];
    if (!file) {
      throw new Error(`${pkg} ${weight} ${style}: a face with no woff2`);
    }
    const subset = file.slice(pkg.length + 1, -`-${weight}-${style}.woff2`.length);
    const range = body.match(/unicode-range:\s*([^;]+);/)?.[1].trim();
    faces.push({ file, subset, ...(range ? { range } : {}) });
  }
  if (!faces.some((f) => f.subset === SKIA_SUBSET)) {
    throw new Error(`${pkg} ${weight} ${style}: no ${SKIA_SUBSET} face`);
  }
  return faces;
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
const manifest = [];
for (const entry of FAMILIES) {
  const pkg = slug(entry.family);
  const pkgDir = path.dirname(require.resolve(`@fontsource/${pkg}/package.json`));
  const styled = [
    ...entry.weights.map((weight) => ({ weight, style: "normal" })),
    ...(entry.italics ?? []).map((weight) => ({ weight, style: "italic" })),
  ];

  // Copy every subset's file; a subset's range is the same at every weight,
  // so the manifest keeps it once per family.
  const faces = [];
  const ranges = {};
  for (const { weight, style } of styled) {
    for (const { file, subset, range } of readFaces(pkgDir, pkg, weight, style)) {
      copyFileSync(path.join(pkgDir, "files", file), path.join(dest, file));
      faces.push({ file, weight, style, subset });
      if (range) {
        ranges[subset] = range;
      }
    }
  }

  manifest.push({
    ...(entry.id ? { id: entry.id } : {}),
    family: entry.family,
    ...(entry.aliases ? { aliases: entry.aliases } : {}),
    // Skia reads weight and slant off each file.
    files: faces.filter((f) => f.subset === SKIA_SUBSET).map((f) => f.file),
    faces,
    ranges,
  });
}
writeFileSync(path.join(dest, "manifest.json"), `${JSON.stringify(manifest)}\n`);
