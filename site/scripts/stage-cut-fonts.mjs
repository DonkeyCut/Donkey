// Stage the Cut font files into public/ for the page and a headless render.
// The families are listed once, in src/cut/lib/fonts.json. Every subset of
// each weight is copied here from its @fontsource package, and the manifest
// records each face's subset and unicode-range: the page adds one lazy
// FontFace per face (googleFonts.ts), and a render worker hands skia the latin
// files (lib/headless/nodeFonts.ts). It also records each face's em box, which
// is where every canvas sets the face's lines (lib/fontEm.ts).
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
import { brotliDecompressSync } from "node:zlib";

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

/** The WOFF2 known-table tags read here, by the index a table directory
 * entry names; glyf and loca are 10 and 11. */
const WOFF2_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post"];

/** A WOFF2 file's untransformed tables by tag. The vertical metrics tables
 * are never transformed, and they come before glyf in the stream. */
function woff2Tables(buf) {
  const count = buf.readUInt16BE(12);
  const packed = buf.readUInt32BE(20);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[p++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    return v;
  };
  const dir = [];
  for (let i = 0; i < count; i++) {
    const flags = buf[p++];
    const known = flags & 0x3f;
    let tag = WOFF2_TAGS[known];
    if (known === 63) {
      tag = buf.toString("latin1", p, p + 4);
      p += 4;
    }
    const version = flags >> 6;
    let length = base128();
    // glyf and loca are transformed at version 0, everything else at not-0.
    if ((known === 10 || known === 11) === (version === 0)) length = base128();
    dir.push({ tag, length });
  }
  const data = brotliDecompressSync(buf.subarray(p, p + packed));
  const tables = {};
  let at = 0;
  for (const { tag, length } of dir) {
    if (tag) tables[tag] = data.subarray(at, at + length);
    at += length;
  }
  return tables;
}

/** A face's em box: the share of the em above the baseline. A canvas sets a
 * line's baseline under the line's middle by the em box's own offset, and
 * Chrome takes the box from OS/2's typo ascender and descender, scaled to
 * fill the em; a face without them falls back to its line ascent and
 * descent. Example: Jost's 1070 and -375 put 0.7405 of the em above. */
function emAscent(file) {
  const t = woff2Tables(readFileSync(file));
  const os2 = t["OS/2"];
  let up = os2 && os2.length >= 72 ? os2.readInt16BE(68) : 0;
  let down = os2 && os2.length >= 72 ? -os2.readInt16BE(70) : 0;
  if (!up && !down) {
    up = t.hhea.readInt16BE(4);
    down = -t.hhea.readInt16BE(6);
  }
  return up + down > 0 ? Math.round((up / (up + down)) * 1e5) / 1e5 : 0.8;
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
      faces.push({ file, weight, style, subset, em: emAscent(path.join(dest, file)) });
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
