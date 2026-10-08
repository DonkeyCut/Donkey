// Stage the Cut font files into public/ so a headless render draws text with
// the same faces the editor shows. The page declares these families from the
// @fontsource stylesheets (googleFonts.ts); a render worker hands skia a file
// path instead, so the latin face of each weight is copied here from the same
// packages under stable names, with a manifest the headless bootstrap reads.
//
// The alias-only families at the bottom cover the base system set (SF Pro,
// New York, Impact…). Those live on a Mac and nowhere else, so a Linux
// container would draw tofu for the default font; the aliases register a
// close stand-in under each name the CSS stacks ask for.
//
// Runs from postinstall and reads only node_modules, so it needs no network.
// A missing face fails the install: the package versions pin the files.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dest = path.join(root, "public", "cut-fonts");
const require = createRequire(import.meta.url);

/** Keep in step with googleFonts.ts, which declares the same families for
 * the page. An id here is a Cut font id; a family with no id is a stand-in. */
const FAMILIES = [
  { id: "inter", label: "Inter", family: "Inter", weights: [400, 700] },
  { id: "montserrat", label: "Montserrat", family: "Montserrat", weights: [400, 700, 800, 900] },
  { id: "poppins", label: "Poppins", family: "Poppins", weights: [400, 700, 800, 900] },
  { id: "oswald", label: "Oswald", family: "Oswald", weights: [400, 700] },
  { id: "space-grotesk", label: "Space Grotesk", family: "Space Grotesk", weights: [400, 700] },
  {
    id: "playfair",
    label: "Playfair Display",
    family: "Playfair Display",
    weights: [400, 700],
    italics: [400, 700],
  },
  { id: "caveat", label: "Caveat", family: "Caveat", weights: [400, 700] },
  { id: "bebas", label: "Bebas Neue", family: "Bebas Neue", weights: [400] },
  {
    id: "anton",
    label: "Anton",
    family: "Anton",
    weights: [400],
    aliases: ["Impact", "Arial Black"],
  },
  { id: "archivo-black", label: "Archivo Black", family: "Archivo Black", weights: [400] },
  { id: "bangers", label: "Bangers", family: "Bangers", weights: [400] },
  { id: "lobster", label: "Lobster", family: "Lobster", weights: [400] },
  { id: "pacifico", label: "Pacifico", family: "Pacifico", weights: [400] },
  { id: "permanent-marker", label: "Permanent Marker", family: "Permanent Marker", weights: [400] },
  { id: "dm-serif", label: "DM Serif Display", family: "DM Serif Display", weights: [400] },
  { id: "amatic", label: "Amatic SC", family: "Amatic SC", weights: [400, 700] },
  // Light and Bold only: font matching draws a 400 title in the Light face,
  // the thin LCD look, and 700–900 in Bold.
  {
    id: "dseg14",
    label: "DSEG14 Classic",
    family: "DSEG14 Classic",
    weights: [300, 700],
    italics: [300, 700],
  },
  {
    family: "Roboto",
    weights: [400, 700],
    aliases: [
      "-apple-system",
      "system-ui",
      "SF Pro Display",
      "SF Pro Text",
      "Helvetica Neue",
      "Helvetica",
      "Arial",
      "sans-serif",
    ],
  },
  {
    family: "Noto Serif",
    weights: [400, 700],
    aliases: ["New York", "ui-serif", "Georgia", "Times New Roman", "serif"],
  },
  {
    family: "Nunito",
    weights: [400, 700],
    aliases: ["ui-rounded", "SF Pro Rounded", "Arial Rounded MT Bold"],
  },
  {
    family: "Roboto Mono",
    weights: [400, 700],
    aliases: ["ui-monospace", "SF Mono", "Menlo", "Courier New", "monospace"],
  },
];

const slug = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, "-");

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
const manifest = [];
for (const entry of FAMILIES) {
  const pkg = slug(entry.family);
  const files = path.join(path.dirname(require.resolve(`@fontsource/${pkg}/package.json`)), "files");
  const staged = entry.weights.map((weight) => {
    const name = `${pkg}-${weight}.woff2`;
    copyFileSync(path.join(files, `${pkg}-latin-${weight}-normal.woff2`), path.join(dest, name));
    return name;
  });
  // Italic faces join the same family; skia reads the slant off the file.
  for (const weight of entry.italics ?? []) {
    const name = `${pkg}-${weight}-italic.woff2`;
    copyFileSync(path.join(files, `${pkg}-latin-${weight}-italic.woff2`), path.join(dest, name));
    staged.push(name);
  }
  manifest.push({
    ...(entry.id ? { id: entry.id, label: entry.label } : {}),
    family: entry.family,
    ...(entry.aliases ? { aliases: entry.aliases } : {}),
    files: staged,
  });
}
writeFileSync(path.join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
