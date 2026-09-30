import { describe, expect, test } from "bun:test";
import { DEFAULT_COLOR, probeColor, probeMissingColors, rangeOfBytes } from "./colorProbe";

// Tiny MOV/MP4 builders: enough of the box structure for the probe to walk.

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
/** A box with a 64-bit size field (a large `mdat`). */
const largeBox = (type: string, body: Uint8Array) =>
  cat(u32(1), str(type), u32(0), u32(16 + body.length), body);
const fullBox = (type: string, ...payload: Uint8Array[]) => box(type, u32(0), ...payload);

const hdlr = (kind: string) => fullBox("hdlr", u32(0), str(kind), new Uint8Array(12), new Uint8Array([0]));

/** A VisualSampleEntry of `format` with 78 bytes of fixed fields, then children. */
const visualEntry = (format: string, ...children: Uint8Array[]) =>
  box(format, new Uint8Array(78), ...children);

const colr = (kind: "nclx" | "nclc", primaries: number, transfer: number, matrix: number, full = false) =>
  box("colr", str(kind), u16(primaries), u16(transfer), u16(matrix), ...(kind === "nclx" ? [new Uint8Array([full ? 0x80 : 0])] : []));

/** hvcC with the given luma bit depth; the other fields are zero. */
const hvcC = (bitDepth: number) => {
  const rec = new Uint8Array(23);
  rec[0] = 1;
  rec[17] = 0xf8 | (bitDepth - 8);
  rec[18] = 0xf8 | (bitDepth - 8);
  return box("hvcC", rec);
};

/** avcC for `profile` with one SPS and one PPS, then the depth fields the
 * high profiles carry. */
const avcC = (profile: number, bitDepth: number) =>
  box(
    "avcC",
    new Uint8Array([1, profile, 0, 40, 0xff, 0xe1]),
    u16(2),
    new Uint8Array([0x67, 0]),
    new Uint8Array([1]),
    u16(2),
    new Uint8Array([0x68, 0]),
    new Uint8Array([0xfd, 0xf8 | (bitDepth - 8), 0xf8 | (bitDepth - 8), 0])
  );

const videoTrak = (entry: Uint8Array) =>
  box("trak", box("mdia", hdlr("vide"), box("minf", box("stbl", fullBox("stsd", u32(1), entry)))));
const audioTrak = () =>
  box("trak", box("mdia", hdlr("soun"), box("minf", box("stbl", fullBox("stsd", u32(1), box("mp4a", new Uint8Array(28)))))));

const movie = (moov: Uint8Array, opts: { mdatFirst?: boolean } = {}) => {
  const ftyp = box("ftyp", str("qt  "), u32(0), str("qt  "));
  const mdat = largeBox("mdat", new Uint8Array(4096));
  return opts.mdatFirst ? cat(ftyp, mdat, moov) : cat(ftyp, moov, mdat);
};

const probe = (file: Uint8Array) => probeColor(rangeOfBytes(file), file.length);

describe("colorProbe", () => {
  test("Apple Log ProRes: identifier in the movie metadata, 2020 matrix, 10-bit", async () => {
    const moov = box(
      "moov",
      audioTrak(),
      videoTrak(visualEntry("apch", colr("nclc", 9, 18, 9))),
      box("udta", box("meta", box("keys", str("mdtacom.apple.rec2020.apple-log"))))
    );
    expect(await probe(movie(moov))).toEqual({
      code: { matrix: "bt2020nc", fullRange: false, bitDepth: 10 },
      detected: "apple-log",
      codec: "apch",
    });
  });

  test("Apple Log 2 wins over the plain identifier", async () => {
    const moov = box(
      "moov",
      videoTrak(visualEntry("apch", colr("nclc", 9, 18, 9))),
      box("udta", box("logs", str("com.apple.apple-wide-gamut.apple-log")))
    );
    expect((await probe(movie(moov))).detected).toBe("apple-log-2");
  });

  test("the custom-gamma identifier reads as Apple Log", async () => {
    const moov = box(
      "moov",
      videoTrak(visualEntry("apcn", colr("nclc", 9, 18, 9))),
      box("udta", box("meta", str("com.apple.proapps.customgamma")))
    );
    expect((await probe(movie(moov))).detected).toBe("apple-log");
  });

  test("HLG HEVC Main10: transfer 18, nclx full-range flag, hvcC depth", async () => {
    const moov = box("moov", videoTrak(visualEntry("hvc1", colr("nclx", 9, 18, 9, true), hvcC(10))));
    expect(await probe(movie(moov))).toEqual({
      code: { matrix: "bt2020nc", fullRange: true, bitDepth: 10 },
      detected: "hlg",
      codec: "hvc1",
    });
  });

  test("PQ reads as pq, sRGB transfer as srgb", async () => {
    const pq = box("moov", videoTrak(visualEntry("hvc1", colr("nclx", 9, 16, 9), hvcC(10))));
    expect((await probe(movie(pq))).detected).toBe("pq");
    const srgb = box("moov", videoTrak(visualEntry("avc1", colr("nclx", 1, 13, 1), avcC(66, 8))));
    expect((await probe(movie(srgb))).detected).toBe("srgb");
  });

  test("Rec.709 H.264 with a high-profile avcC depth", async () => {
    const moov = box("moov", videoTrak(visualEntry("avc1", colr("nclx", 1, 1, 1), avcC(110, 10))));
    expect(await probe(movie(moov))).toEqual({
      code: { matrix: "bt709", fullRange: false, bitDepth: 10 },
      detected: "rec709",
      codec: "avc1",
    });
    const baseline = box("moov", videoTrak(visualEntry("avc1", colr("nclx", 1, 1, 1), avcC(66, 10))));
    expect((await probe(movie(baseline))).code.bitDepth).toBe(8);
  });

  test("BT.601 matrices map to bt601; no colr means Rec.709", async () => {
    const sd = box("moov", videoTrak(visualEntry("avc1", colr("nclx", 6, 6, 6), avcC(66, 8))));
    expect((await probe(movie(sd))).code.matrix).toBe("bt601");
    const bare = box("moov", videoTrak(visualEntry("avc1", avcC(66, 8))));
    expect(await probe(movie(bare))).toEqual({ ...DEFAULT_COLOR, codec: "avc1" });
  });

  test("moov after a large mdat is reached by skipping the data box", async () => {
    const moov = box("moov", videoTrak(visualEntry("hvc1", colr("nclx", 9, 18, 9), hvcC(10))));
    const file = cat(box("ftyp", str("qt  "), u32(0)), largeBox("mdat", new Uint8Array(8 * 2 ** 20)), moov);
    let read = 0;
    const result = await probeColor(async (offset, length) => {
      read += Math.min(length, file.length - offset);
      return file.subarray(offset, offset + length);
    }, file.length);
    expect(result.detected).toBe("hlg");
    // The first block and the file's tail: the data box is never pulled.
    expect(read).toBeLessThan(256 * 1024);
  });

  test("a file that is not MOV/MP4 reads as Rec.709", async () => {
    const webm = cat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), new Uint8Array(512));
    expect(await probe(webm)).toEqual(DEFAULT_COLOR);
    expect(await probe(new Uint8Array(0))).toEqual(DEFAULT_COLOR);
  });

  test("a truncated moov settles on what it holds", async () => {
    const moov = box("moov", videoTrak(visualEntry("hvc1", colr("nclx", 9, 18, 9), hvcC(10))));
    const file = cat(box("ftyp", str("isom"), u32(0)), moov);
    expect(await probe(file.subarray(0, file.length - 3))).toEqual(DEFAULT_COLOR);
  });

  test("the matrix decides HDR: a bt709-matrix file with HLG or PQ tags is Rec.709", async () => {
    // A social app's 8-bit H.264 transcode keeps the phone's 2020/HLG tags
    // and converts through the Rec.709 matrix.
    const social = box("moov", videoTrak(visualEntry("avc1", colr("nclx", 9, 18, 1), avcC(100, 8))));
    expect(await probe(movie(social))).toEqual({
      code: { matrix: "bt709", fullRange: false, bitDepth: 8 },
      detected: "rec709",
      codec: "avc1",
    });
    const pq709 = box("moov", videoTrak(visualEntry("hvc1", colr("nclx", 9, 16, 1), hvcC(10))));
    expect((await probe(movie(pq709))).detected).toBe("rec709");
  });

  test("an unspecified matrix on BT.2020 primaries reads as BT.2020", async () => {
    const moov = box("moov", videoTrak(visualEntry("hvc1", colr("nclx", 9, 18, 2), hvcC(10))));
    expect(await probe(movie(moov))).toEqual({
      code: { matrix: "bt2020nc", fullRange: false, bitDepth: 10 },
      detected: "hlg",
      codec: "hvc1",
    });
    const sdr = box("moov", videoTrak(visualEntry("avc1", colr("nclx", 1, 18, 2), avcC(66, 8))));
    expect((await probe(movie(sdr))).detected).toBe("rec709");
  });

  test("the sample tables are stepped over, never read", async () => {
    // Hours of footage: megabytes of sample sizes and chunk offsets after the
    // sample description, then the movie metadata.
    const tables = new Uint8Array(6 * 2 ** 20).fill(0x61);
    const trak = box(
      "trak",
      box(
        "mdia",
        hdlr("vide"),
        box(
          "minf",
          box(
            "stbl",
            fullBox("stsd", u32(1), visualEntry("apch", colr("nclc", 9, 1, 9))),
            fullBox("stsz", u32(0), tables),
            fullBox("stco", tables.subarray(0, 2 ** 20))
          )
        )
      )
    );
    const moov = box("moov", trak, box("meta", box("keys", str("mdtacom.apple.apple-wide-gamut.apple-log"))));
    const file = movie(moov, { mdatFirst: true });
    let read = 0;
    const result = await probeColor(async (offset, length) => {
      read += Math.min(length, file.length - offset);
      return file.subarray(offset, offset + length);
    }, file.length);
    expect(result.detected).toBe("apple-log-2");
    expect(result.code).toEqual({ matrix: "bt2020nc", fullRange: false, bitDepth: 10 });
    expect(read).toBeLessThan(512 * 1024);
  });

  test("a movie header at the end of the file costs two reads", async () => {
    const moov = box("moov", videoTrak(visualEntry("hvc1", colr("nclx", 9, 18, 9), hvcC(10))));
    const file = cat(box("ftyp", str("qt  "), u32(0)), largeBox("mdat", new Uint8Array(3 * 2 ** 20)), moov);
    let reads = 0;
    const result = await probeColor(async (offset, length) => {
      reads++;
      return file.subarray(offset, offset + length);
    }, file.length);
    expect(result.detected).toBe("hlg");
    expect(reads).toBe(2);
  });

  test("a probe of unknown length walks until a read comes back short", async () => {
    const moov = box("moov", videoTrak(visualEntry("hvc1", colr("nclx", 9, 16, 9), hvcC(10))));
    const file = movie(moov, { mdatFirst: true });
    expect((await probeColor(rangeOfBytes(file))).detected).toBe("pq");
  });
});

describe("probeMissingColors", () => {
  const assets = [
    { id: "drawn", type: "video", fileName: "drawn.mp4" },
    { id: "shelf", type: "video", fileName: "shelf.mp4" },
  ];
  const probe = async (a: { fileName: string }) => {
    if (a.fileName === "shelf.mp4") throw new Error("unreadable");
    return DEFAULT_COLOR;
  };

  test("an unreadable file nothing draws is never read", async () => {
    const found = await probeMissingColors(assets, new Set(["drawn"]), probe);
    expect([...found.keys()]).toEqual(["drawn.mp4"]);
  });

  test("an unreadable file the timeline draws fails the call, naming it", async () => {
    await expect(probeMissingColors(assets, new Set(["drawn", "shelf"]), probe)).rejects.toThrow(
      "The color of shelf.mp4 could not be read"
    );
  });
});
