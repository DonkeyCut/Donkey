// Stage the Cut font files into public/ so a headless render draws text with
// the same faces the editor shows. The page gets these families from
// next/font/google, which downloads them during `next build` and serves them
// under hashed names — fine for a browser, useless to a render worker that
// needs a file path to hand skia. So the same faces are staged here under
// stable names, with a manifest the headless bootstrap reads.
//
// The alias-only families at the bottom cover the base system set (SF Pro,
// New York, Impact…). Those live on a Mac and nowhere else, so a Linux
// container would draw tofu for the default font; the aliases register a
// close stand-in under each name the CSS stacks ask for.
//
// Files are fetched once and kept, so a re-install is free and an offline one
// keeps working. Runs from postinstall; a failure warns and leaves whatever
// is already staged.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dest = path.join(root, "public", "cut-fonts");

/** Keep in step with googleFonts.ts, which registers the same families for
 * the page. An id here is a Cut font id; a family with no id is a stand-in. */
const FAMILIES = [
  { id: "inter", label: "Inter", family: "Inter", weights: [400, 700] },
  { id: "montserrat", label: "Montserrat", family: "Montserrat", weights: [400, 700] },
  { id: "poppins", label: "Poppins", family: "Poppins", weights: [400, 700] },
  { id: "oswald", label: "Oswald", family: "Oswald", weights: [400, 700] },
  { id: "space-grotesk", label: "Space Grotesk", family: "Space Grotesk", weights: [400, 700] },
  { id: "playfair", label: "Playfair Display", family: "Playfair Display", weights: [400, 700] },
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

// A browser UA gets woff2 back; skia reads it, and it is a fraction of a ttf.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const slug = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** The latin-subset file URL for each weight of one family. Blocks arrive one
 * per subset, each headed by its /* subset *\/ comment; latin carries the
 * characters a title is written in. */
async function faceUrls(family, weights) {
  const spec = `${family.replace(/ /g, "+")}:wght@${weights.join(";")}`;
  const res = await fetch(`https://fonts.googleapis.com/css2?family=${spec}&display=swap`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`css2 answered ${res.status}`);
  const css = await res.text();
  const found = new Map();
  for (const [, subset, body] of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)) {
    if (subset !== "latin") continue;
    const weight = Number(body.match(/font-weight:\s*(\d+)/)?.[1]);
    const url = body.match(/src:\s*url\((https:[^)]+)\)/)?.[1];
    if (weight && url && !found.has(weight)) found.set(weight, url);
  }
  return found;
}

mkdirSync(dest, { recursive: true });
const staged = new Set(readdirSync(dest));
const manifest = [];
for (const entry of FAMILIES) {
  const fileFor = (weight) => `${slug(entry.family)}-${weight}.woff2`;
  const files = entry.weights.map(fileFor);
  try {
    if (files.some((f) => !staged.has(f))) {
      const urls = await faceUrls(entry.family, entry.weights);
      for (const weight of entry.weights) {
        const name = fileFor(weight);
        if (staged.has(name)) continue;
        const url = urls.get(weight);
        if (!url) throw new Error(`no latin face at weight ${weight}`);
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (!res.ok) throw new Error(`weight ${weight} answered ${res.status}`);
        writeFileSync(path.join(dest, name), Buffer.from(await res.arrayBuffer()));
        staged.add(name);
      }
    }
    manifest.push({
      ...(entry.id ? { id: entry.id, label: entry.label } : {}),
      family: entry.family,
      ...(entry.aliases ? { aliases: entry.aliases } : {}),
      files,
    });
  } catch (err) {
    // One family that will not come down is one font a headless render falls
    // back for; the rest still stage.
    console.warn(`fetch-cut-fonts: ${entry.family}: ${err instanceof Error ? err.message : err}`);
  }
}
writeFileSync(path.join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
