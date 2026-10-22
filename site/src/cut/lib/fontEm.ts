import manifest from "../../../public/cut-fonts/manifest.json";

/**
 * Each staged face's em box: the share of the em above its baseline, read off
 * the face's own OS/2 table when the fonts were staged
 * (scripts/stage-cut-fonts.mjs).
 *
 * A title's lines are set from the em box's middle (the kit's
 * `baselineDrop`). Chrome reads that box itself when it draws textBaseline
 * "middle"; skia and Safari read other boxes, so the box comes from here and
 * every canvas sets a face's lines where Chrome does. A face that is not
 * staged — a system face in the page, an uploaded font — is not known here,
 * and the painter reads its canvas instead.
 */

interface FaceEm {
  weight: number;
  italic: boolean;
  em: number;
}

/** One staged family's faces as the manifest lists them. */
interface StagedFamily {
  family: string;
  faces: { weight: number; style: string; em?: number }[];
}

const byFamily = new Map<string, FaceEm[]>();
for (const entry of manifest as StagedFamily[]) {
  const faces = entry.faces.flatMap((f) =>
    f.em === undefined ? [] : [{ weight: f.weight, italic: f.style === "italic", em: f.em }]
  );
  if (faces.length) byFamily.set(entry.family.toLowerCase(), faces);
}

/** Each css font's reading, by css font. */
const read = new Map<string, number | undefined>();

/** Answer for `alias` with a staged family's faces: a headless render draws
 * the system names the font stacks ask for in a stand-in, so the stand-in's
 * em box is the one it sets. */
export function aliasFaceEm(alias: string, family: string): void {
  const faces = byFamily.get(family.toLowerCase());
  if (!faces) return;
  byFamily.set(alias.toLowerCase(), faces);
  read.clear();
}

/**
 * The share of the em above the baseline for the face a css font draws in,
 * as the kit painter's `emAscent` takes it; undefined when its first family
 * is not a staged one. A weight the family does not stage reads the nearest
 * one it does, as a browser matches it. Example: '700 110px "Jost"' → 0.74048.
 */
export function faceEmAscent(cssFont: string): number | undefined {
  if (read.has(cssFont)) return read.get(cssFont);
  const m = /^(?:(italic|oblique)\s+)?(?:normal\s+)?(?:(\d+)\s+)?[\d.]+px\s+(.+)$/.exec(cssFont.trim());
  let em: number | undefined;
  const faces = m ? byFamily.get(m[3].split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase()) : undefined;
  if (m && faces) {
    const italic = !!m[1];
    const weight = Number(m[2] ?? 400);
    const slant = faces.filter((f) => f.italic === italic);
    const pool = slant.length ? slant : faces;
    em = pool.reduce((a, b) => (Math.abs(b.weight - weight) < Math.abs(a.weight - weight) ? b : a)).em;
  }
  // Bounded: every stage size is a font string of its own.
  if (read.size > 500) read.clear();
  read.set(cssFont, em);
  return em;
}
