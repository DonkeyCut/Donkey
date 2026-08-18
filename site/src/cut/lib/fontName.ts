/**
 * The family name a font file calls itself, read out of the sfnt `name` table.
 *
 * The Library shows a font under this name, and there is no rename, so the
 * label has to be right the moment the file lands: "Cera Pro" reads as a font,
 * "CeraPro-Regular-webfont" reads as a download. TrueType and OpenType carry
 * the table in the clear. WOFF and WOFF2 compress it, so those fall back to the
 * file name, which is what a web-delivery file usually says anyway.
 */

const u16 = (v: DataView, at: number) => v.getUint16(at);
const u32 = (v: DataView, at: number) => v.getUint32(at);

/** Name records worth reading, best first: the typographic family (16) names
 * the whole family where the legacy family (1) splits weights into families of
 * their own ("Cera Pro Bold"). */
const NAME_IDS = [16, 1];

/** UTF-16BE for the Windows and Unicode platforms; Mac (platform 1) is a
 * single-byte encoding whose ASCII range is all we need from it. */
function decodeName(bytes: Uint8Array, platformId: number): string {
  if (platformId === 1) return new TextDecoder("latin1").decode(bytes);
  return new TextDecoder("utf-16be").decode(bytes);
}

/** The font's own family name, or null when the file does not carry a readable
 * one (a compressed web font, a collection, damaged bytes). */
export function familyNameFromSfnt(buf: ArrayBuffer): string | null {
  try {
    const v = new DataView(buf);
    if (buf.byteLength < 12) return null;
    const tag = u32(v, 0);
    // 0x00010000 TrueType, "OTTO" OpenType CFF, "true" older Mac TrueType.
    if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null;
    const tables = u16(v, 4);
    let nameAt = 0;
    for (let i = 0; i < tables; i++) {
      const rec = 12 + i * 16;
      if (rec + 16 > buf.byteLength) return null;
      if (u32(v, rec) === 0x6e616d65) {
        nameAt = u32(v, rec + 8);
        break;
      }
    }
    if (!nameAt || nameAt + 6 > buf.byteLength) return null;
    const count = u16(v, nameAt + 2);
    const strings = nameAt + u16(v, nameAt + 4);
    const found = new Map<number, string>();
    for (let i = 0; i < count; i++) {
      const rec = nameAt + 6 + i * 12;
      if (rec + 12 > buf.byteLength) break;
      const platformId = u16(v, rec);
      const nameId = u16(v, rec + 6);
      if (!NAME_IDS.includes(nameId)) continue;
      // The first record for a name id wins; the table lists the platforms in
      // preference order and every one of them says the same family.
      if (found.has(nameId)) continue;
      const len = u16(v, rec + 8);
      const at = strings + u16(v, rec + 10);
      if (at + len > buf.byteLength) continue;
      const text = decodeName(new Uint8Array(buf, at, len), platformId).trim();
      if (text) found.set(nameId, text);
    }
    for (const id of NAME_IDS) {
      const hit = found.get(id);
      if (hit) return hit;
    }
    return null;
  } catch {
    return null;
  }
}

/** What to label an uploaded font: its own family name, else the file name with
 * its extension dropped. */
export function fontLabelFor(buf: ArrayBuffer, fileName: string): string {
  return (
    familyNameFromSfnt(buf) ||
    fileName.replace(/\.(ttf|otf|woff2?)$/i, "").trim() ||
    "Custom font"
  );
}
