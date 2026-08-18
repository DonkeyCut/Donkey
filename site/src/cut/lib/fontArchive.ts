/**
 * Font files out of a .zip.
 *
 * A zip is what a font arrives as — Google Fonts hands you one, and so do most
 * foundries — so a zip is what a user drags onto the Library. Reading it here
 * means the file they have in hand is the file that works.
 *
 * Just enough of the ZIP format to walk the central directory and inflate the
 * entries that are fonts; `DecompressionStream` does the real work and exists
 * in both a page and a job.
 */

const FONT_ENTRY = /\.(ttf|otf|woff2?)$/i;
/** Finder's resource-fork shadow directory, and dotfiles generally. */
const JUNK = /(^|\/)(__MACOSX\/|\.)/;

export function isFontArchive(file: File): boolean {
  return file.type === "application/zip" || /\.zip$/i.test(file.name);
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderAt: number;
}

/** Walk the central directory backwards from the end-of-directory record. */
function readDirectory(v: DataView): ZipEntry[] {
  const end = v.byteLength;
  let eocd = -1;
  // The record is 22 bytes plus a comment of up to 64KB.
  for (let at = end - 22; at >= 0 && at > end - 22 - 0x10000; at--) {
    if (v.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = v.getUint16(eocd + 10, true);
  let at = v.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || v.getUint32(at, true) !== 0x02014b50) break;
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    entries.push({
      name: new TextDecoder().decode(
        new Uint8Array(v.buffer, at + 46, nameLen),
      ),
      method: v.getUint16(at + 10, true),
      compressedSize: v.getUint32(at + 20, true),
      localHeaderAt: v.getUint32(at + 42, true),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(
  buf: ArrayBuffer,
  v: DataView,
  entry: ZipEntry,
): Promise<Blob | null> {
  const at = entry.localHeaderAt;
  if (at + 30 > v.byteLength || v.getUint32(at, true) !== 0x04034b50)
    return null;
  const from =
    at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true);
  const raw = buf.slice(from, from + entry.compressedSize);
  if (entry.method === 0) return new Blob([raw]);
  if (entry.method !== 8) return null; // Only stored and deflated; fonts are one or the other.
  try {
    const stream = new Blob([raw])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return await new Response(stream).blob();
  } catch {
    return null;
  }
}

/** The family a face belongs to, from its file name: "Montserrat-Bold.ttf" and
 * "Montserrat-Regular.ttf" are one family. */
const familyOf = (name: string) =>
  name
    .replace(/\.[^.]+$/, "")
    .split(/[-_]/)[0]
    .toLowerCase();

/** How much a face wants to be the one taken from its family: a variable font
 * covers every weight, and a regular is the face a family is read in. */
function rank(name: string): number {
  if (/variablefont/i.test(name)) return 3;
  if (/-regular\./i.test(name)) return 2;
  if (/italic|bold|light|thin|black|medium|semi|extra/i.test(name)) return 0;
  return 1;
}

/**
 * The fonts worth taking out of an archive: one face per family.
 *
 * A family download carries a face per weight — eighteen of them, for some — so
 * taking every one would fill the font menu with near-identical rows and charge
 * the account for all of them. The face that stands for the family comes out,
 * weight and italic stay the inspector's controls, and someone who wants a
 * particular weight uploads that file on its own.
 */
export async function fontsFromArchive(file: File): Promise<File[]> {
  let buf: ArrayBuffer;
  try {
    buf = await file.arrayBuffer();
  } catch {
    return [];
  }
  const v = new DataView(buf);
  const fonts = readDirectory(v).filter(
    (e) => FONT_ENTRY.test(e.name) && !JUNK.test(e.name),
  );
  const best = new Map<string, ZipEntry>();
  for (const entry of fonts) {
    const base = entry.name.split("/").pop() ?? entry.name;
    const family = familyOf(base);
    const held = best.get(family);
    if (!held || rank(base) > rank(held.name.split("/").pop() ?? held.name)) {
      best.set(family, entry);
    }
  }
  const out: File[] = [];
  for (const entry of best.values()) {
    const blob = await readEntry(buf, v, entry);
    if (blob)
      out.push(new File([blob], entry.name.split("/").pop() ?? entry.name));
  }
  return out;
}
