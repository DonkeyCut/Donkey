import { describe, expect, test } from "bun:test";
import { familyNameFromSfnt, fontLabelFor } from "./fontName";

/** A minimal but real sfnt: a table directory holding one `name` table whose
 * records are UTF-16BE on the Windows platform, which is what a shipped font
 * carries. */
function sfnt(records: { nameId: number; text: string }[], tag = 0x00010000): ArrayBuffer {
  const strings: number[] = [];
  const meta = records.map((r) => {
    const at = strings.length;
    for (const c of [...r.text]) {
      const unit = c.charCodeAt(0);
      strings.push(unit >> 8, unit & 0xff);
    }
    return { nameId: r.nameId, at, len: strings.length - at };
  });
  const nameLen = 6 + meta.length * 12 + strings.length;
  const buf = new ArrayBuffer(28 + nameLen);
  const v = new DataView(buf);
  v.setUint32(0, tag);
  v.setUint16(4, 1);
  v.setUint32(12, 0x6e616d65);
  v.setUint32(20, 28);
  v.setUint32(24, nameLen);
  const at = 28;
  v.setUint16(at + 2, meta.length);
  v.setUint16(at + 4, 6 + meta.length * 12);
  meta.forEach((m, i) => {
    const rec = at + 6 + i * 12;
    v.setUint16(rec, 3);
    v.setUint16(rec + 2, 1);
    v.setUint16(rec + 4, 0x0409);
    v.setUint16(rec + 6, m.nameId);
    v.setUint16(rec + 8, m.len);
    v.setUint16(rec + 10, m.at);
  });
  new Uint8Array(buf).set(strings, at + 6 + meta.length * 12);
  return buf;
}

describe("familyNameFromSfnt", () => {
  test("prefers the typographic family over the legacy one", () => {
    const buf = sfnt([
      { nameId: 1, text: "Cera Pro Bold" },
      { nameId: 16, text: "Cera Pro" },
    ]);
    expect(familyNameFromSfnt(buf)).toBe("Cera Pro");
  });

  test("falls back to the legacy family when there is no typographic name", () => {
    expect(familyNameFromSfnt(sfnt([{ nameId: 1, text: "Bandit Grotesk" }]))).toBe("Bandit Grotesk");
  });

  test("reads an OpenType CFF file", () => {
    expect(familyNameFromSfnt(sfnt([{ nameId: 16, text: "Wanderlust" }], 0x4f54544f))).toBe(
      "Wanderlust"
    );
  });

  test("declines anything that is not an sfnt", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).buffer;
    expect(familyNameFromSfnt(zip)).toBe(null);
    expect(familyNameFromSfnt(new ArrayBuffer(4))).toBe(null);
  });
});

describe("fontLabelFor", () => {
  test("uses the font's own family name", () => {
    expect(fontLabelFor(sfnt([{ nameId: 16, text: "Cera Pro" }]), "CeraPro-Regular.otf")).toBe(
      "Cera Pro"
    );
  });

  test("falls back to the file name with its extension dropped", () => {
    expect(fontLabelFor(new ArrayBuffer(8), "Bandit-Grotesk.woff2")).toBe("Bandit-Grotesk");
  });

  test("always has something to show", () => {
    expect(fontLabelFor(new ArrayBuffer(8), ".otf")).toBe("Custom font");
  });
});
