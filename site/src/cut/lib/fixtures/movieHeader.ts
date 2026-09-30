/** A MOV/MP4 of headers alone: ftyp, a small data box and a movie header
 * whose one video track's sample entry carries `colr` — enough for the
 * color probe (colorProbe.ts) to settle a file's color in tests. */

const str = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const u16 = (n: number) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const box = (type: string, ...payload: Uint8Array[]) => {
  const body = cat(...payload);
  return cat(u32(8 + body.length), str(type), body);
};
const fullBox = (type: string, ...payload: Uint8Array[]) => box(type, u32(0), ...payload);

/** The file's bytes, tagged with `colr` nclx codes. */
export function movieHeader(tags: { primaries: number; transfer: number; matrix: number; fullRange?: boolean }): Uint8Array {
  const colr = box(
    "colr",
    str("nclx"),
    u16(tags.primaries),
    u16(tags.transfer),
    u16(tags.matrix),
    new Uint8Array([tags.fullRange ? 0x80 : 0])
  );
  const entry = box("avc1", new Uint8Array(78), colr);
  const hdlr = fullBox("hdlr", u32(0), str("vide"), new Uint8Array(12), new Uint8Array([0]));
  const trak = box("trak", box("mdia", hdlr, box("minf", box("stbl", fullBox("stsd", u32(1), entry)))));
  return cat(box("ftyp", str("isom"), u32(0)), box("mdat", new Uint8Array(64)), box("moov", trak));
}
