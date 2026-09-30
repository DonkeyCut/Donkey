import { describe, expect, test } from "bun:test";
import {
  BitWriter,
  NEUTRAL_TAGS,
  SpsColorRewriter,
  descriptionLengthSize,
  escapeRbsp,
  readSpsColor,
  rewriteSpsColor,
  unescapeRbsp,
} from "./spsColor";

// Codec descriptions (avcC / hvcC) read off files the bundled ffmpeg
// encoded, before and after its h264_metadata / hevc_metadata filters set
// colour_primaries=1, transfer_characteristics=13, matrix_coefficients=1,
// video_full_range_flag=0. `iphoneHevc` is a 1080p HEVC phone recording.
const DESC = {
  h264hlg: "AU0AC//hABAnTQALq0GG8CDCM1CRIJAgAQAEKO48gA==",
  h264hlgRewritten: "AU0AC//hABAnTQALq0GG8CDCM1AQ0BAgAQAEKO48gA==",
  h264709: "AU0AC//hABAnTQALq0GG8CDCM1AQEBAgAQAEKO48gA==",
  h264709Rewritten: "AU0AC//hABAnTQALq0GG8CDCM1AQ0BAgAQAEKO48gA==",
  hevc10hlg: "AQIgAAAAsAAAAAAAHvAA/P36+gAADwOgAAEAGEABDAH//wIgAAADALAAAAMAAAMAHhcCQKEAAQAqQgEBAiAAAAMAsAAAAwAAAwAeoBQgQcGO2IF7kWRS/8ufxP6wFqEiQSAQogABAAdEAcBy9FNk",
  hevc10hlgRewritten: "AQIgAAAAsAAAAAAAHvAA/P36+gAADwOgAAEAGEABDAH//wIgAAADALAAAAMAAAMAHhcCQKEAAQAqQgEBAiAAAAMAsAAAAwAAAwAeoBQgQcGO2IF7kWRS/8ufxP6wFqAhoCAQogABAAdEAcBy9FNk",
  iphonehevc: "AQFgAAAAsAAAAAAAePAA/P34+AAACwOgAAEAGEABDAH//wFgAAADALAAAAMAAAMAeBXAkKEAAQAkQgEBAWAAAAMAsAAAAwAAAwB4oAPAgBEHy4gV7kWVTUBAQEAgogABAAdEAcAsvBTJ",
  iphonehevcRewritten: "AQFgAAAAsAAAAAAAePAA/P34+AAADwOgAAEAGEABDAH//wFgAAADALAAAAMAAAMAeBXAkKEAAQAkQgEBAWAAAAMAsAAAAwAAAwB4oAPAgBEHy4gV7kWVTUBDQEAgogABAAdEAcAsvBTJ",
};

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const NEUTRAL = NEUTRAL_TAGS(false);

describe("spsColor against ffmpeg's metadata filters", () => {
  test("H.264 avcC tagged bt2020/HLG comes out byte-identical to h264_metadata", () => {
    const rw = new SpsColorRewriter("avc", NEUTRAL);
    expect(hex(rw.description(b64(DESC.h264hlg)))).toBe(hex(b64(DESC.h264hlgRewritten)));
  });
  test("H.264 avcC already Rec.709 only changes the transfer", () => {
    const rw = new SpsColorRewriter("avc", NEUTRAL);
    expect(hex(rw.description(b64(DESC.h264709)))).toBe(hex(b64(DESC.h264709Rewritten)));
  });
  test("HEVC Main10 hvcC tagged bt2020/HLG comes out byte-identical to hevc_metadata", () => {
    const rw = new SpsColorRewriter("hevc", NEUTRAL);
    expect(hex(rw.description(b64(DESC.hevc10hlg)))).toBe(hex(b64(DESC.hevc10hlgRewritten)));
  });
  test("a phone's HEVC hvcC comes out with the same parameter sets as hevc_metadata", () => {
    const rw = new SpsColorRewriter("hevc", NEUTRAL);
    const made = rw.description(b64(DESC.iphonehevc));
    const ffmpeg = b64(DESC.iphonehevcRewritten);
    // ffmpeg rebuilds the hvcC header from the SPS and flips
    // temporalIdNested (byte 21) on this file; the rewriter keeps the header.
    expect(hex(made.subarray(22))).toBe(hex(ffmpeg.subarray(22)));
    expect(hex(made.subarray(0, 21))).toBe(hex(ffmpeg.subarray(0, 21)));
    expect(made[21] & 3).toBe(ffmpeg[21] & 3);
  });
  test("descriptions declare their NAL length size", () => {
    expect(descriptionLengthSize("avc", b64(DESC.h264hlg))).toBe(4);
    expect(descriptionLengthSize("hevc", b64(DESC.iphonehevc))).toBe(4);
  });
});

/** Every SPS NAL inside a description, for the in-band sample tests. */
function spsOf(codec: "avc" | "hevc", desc: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (codec === "avc") {
    let at = 6;
    for (let i = 0; i < (desc[5] & 0x1f); i++) {
      const len = (desc[at] << 8) | desc[at + 1];
      out.push(desc.subarray(at + 2, at + 2 + len));
      at += 2 + len;
    }
  } else {
    let at = 23;
    for (let a = 0; a < desc[22]; a++) {
      const type = desc[at] & 0x3f;
      const count = (desc[at + 1] << 8) | desc[at + 2];
      at += 3;
      for (let i = 0; i < count; i++) {
        const len = (desc[at] << 8) | desc[at + 1];
        if (type === 33) out.push(desc.subarray(at + 2, at + 2 + len));
        at += 2 + len;
      }
    }
  }
  return out;
}

const withLength = (nal: Uint8Array) =>
  new Uint8Array([nal.length >>> 24, (nal.length >>> 16) & 255, (nal.length >>> 8) & 255, nal.length & 255, ...nal]);

describe("in-band parameter sets", () => {
  test("a sample carrying an SPS has it rewritten and its length fixed; the rest is untouched", () => {
    const desc = b64(DESC.hevc10hlg);
    const [sps] = spsOf("hevc", desc);
    const rw = new SpsColorRewriter("hevc", NEUTRAL);
    const slice = new Uint8Array([0x26, 0x01, 0xaf, 0x00, 0x00, 0x03, 0x01, 0x42]); // IDR-ish payload
    const sample = new Uint8Array([...withLength(sps), ...withLength(slice)]);
    const made = rw.sample(sample, 4);
    expect(made).not.toBeNull();
    const expectedSps = rewriteSpsColor("hevc", sps, NEUTRAL);
    expect(hex(made!)).toBe(hex(new Uint8Array([...withLength(expectedSps), ...withLength(slice)])));
    expect(readSpsColor("hevc", expectedSps)).toMatchObject({ primaries: 1, transfer: 13, matrix: 1, fullRange: false });
  });
  test("a sample without an SPS is left alone (null)", () => {
    const rw = new SpsColorRewriter("avc", NEUTRAL);
    const slice = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x21]);
    expect(rw.sample(withLength(slice), 4)).toBeNull();
  });
  test("the same SPS bytes rewrite once", () => {
    const desc = b64(DESC.h264hlg);
    const [sps] = spsOf("avc", desc);
    const rw = new SpsColorRewriter("avc", NEUTRAL);
    expect(rw.sps(sps)).toBe(rw.sps(new Uint8Array(sps)));
  });
});

/** An H.264 SPS RBSP with the given shape, written field by field. */
function avcSps(opts: {
  profile: number;
  scaling?: boolean;
  pocType?: number;
  vui?: null | { aspect255?: boolean; signal?: { full: boolean; described: boolean } };
}): Uint8Array {
  const w = new BitWriter();
  w.u(opts.profile, 8);
  w.u(0, 8);
  w.u(40, 8);
  w.ue(0);
  if ([100, 110, 122, 244].includes(opts.profile)) {
    w.ue(1); // chroma 4:2:0
    w.ue(2); // bit depth luma 10
    w.ue(2);
    w.u(0, 1);
    w.u(opts.scaling ? 1 : 0, 1);
    if (opts.scaling) {
      for (let i = 0; i < 8; i++) {
        w.u(1, 1);
        // a list that ends early through a zero next scale
        w.se(-8);
      }
    }
  }
  w.ue(4);
  w.ue(opts.pocType ?? 0);
  if ((opts.pocType ?? 0) === 0) w.ue(4);
  else if (opts.pocType === 1) {
    w.u(0, 1);
    w.se(-3);
    w.se(2);
    w.ue(2);
    w.se(1);
    w.se(-1);
  }
  w.ue(2);
  w.u(0, 1);
  w.ue(119);
  w.ue(67);
  w.u(1, 1);
  w.u(1, 1);
  w.u(1, 1); // cropping
  w.ue(0);
  w.ue(0);
  w.ue(0);
  w.ue(4);
  if (opts.vui === null) {
    w.u(0, 1);
  } else {
    w.u(1, 1);
    const vui = opts.vui ?? {};
    if (vui.aspect255) {
      w.u(1, 1);
      w.u(255, 8);
      w.u(1, 16);
      w.u(1, 16);
    } else w.u(0, 1);
    w.u(1, 1);
    w.u(1, 1); // overscan appropriate
    if (vui.signal) {
      w.u(1, 1);
      w.u(5, 3);
      w.u(vui.signal.full ? 1 : 0, 1);
      w.u(vui.signal.described ? 1 : 0, 1);
      if (vui.signal.described) {
        w.u(9, 8);
        w.u(18, 8);
        w.u(9, 8);
      }
    } else w.u(0, 1);
    w.u(0, 1); // chroma loc
    w.u(1, 1); // timing info
    w.u(1001, 32);
    w.u(60000, 32);
    w.u(1, 1);
    w.u(0, 1);
    w.u(0, 1);
    w.u(0, 1);
    w.u(1, 1); // bitstream restriction
    w.u(1, 1);
    w.ue(0);
    w.ue(0);
    w.ue(16);
    w.ue(16);
    w.ue(4);
    w.ue(4);
  }
  w.trailing();
  return new Uint8Array([0x67, ...escapeRbsp(w.toBytes())]);
}

/** Bits after the video signal block, as a string, for comparing tails. */
function tailBits(codec: "avc" | "hevc", nal: Uint8Array): string {
  const rbsp = unescapeRbsp(nal.subarray(codec === "avc" ? 1 : 2));
  const bits = Array.from(rbsp, (b) => b.toString(2).padStart(8, "0")).join("");
  // Everything from the colour block on is 27 bits of tags; the tail is what
  // follows them. Locating it requires the parse, so the test compares the
  // last 40 bits before the stop bit, which sit in the tail in every shape.
  const stop = bits.lastIndexOf("1");
  return bits.slice(Math.max(0, stop - 40), stop);
}

describe("SPS shapes", () => {
  const shapes: [string, Uint8Array][] = [
    ["baseline, VUI with signal", avcSps({ profile: 66, vui: { signal: { full: true, described: true } } })],
    ["high 10 with scaling lists, poc type 1", avcSps({ profile: 110, scaling: true, pocType: 1, vui: { aspect255: true, signal: { full: false, described: false } } })],
    ["high, VUI without signal block", avcSps({ profile: 100, vui: {} })],
    ["main, no VUI at all", avcSps({ profile: 77, vui: null })],
  ];
  for (const [name, nal] of shapes) {
    test(`H.264 ${name}`, () => {
      const before = readSpsColor("avc", nal);
      const made = rewriteSpsColor("avc", nal, { primaries: 1, transfer: 13, matrix: 1, fullRange: before?.fullRange ?? false });
      expect(readSpsColor("avc", made)).toEqual({
        videoFormat: before?.videoFormat ?? 5,
        primaries: 1,
        transfer: 13,
        matrix: 1,
        fullRange: before?.fullRange ?? false,
      });
      if (name !== "main, no VUI at all") expect(tailBits("avc", made)).toBe(tailBits("avc", nal));
      // Idempotent: rewriting the result changes nothing.
      expect(hex(rewriteSpsColor("avc", made, { primaries: 1, transfer: 13, matrix: 1, fullRange: before?.fullRange ?? false }))).toBe(hex(made));
    });
  }
  test("H.264 rewrite inserts emulation prevention where the new bytes need it", () => {
    const nal = avcSps({ profile: 66, vui: { signal: { full: false, described: true } } });
    const made = rewriteSpsColor("avc", nal, { primaries: 0, transfer: 0, matrix: 1, fullRange: false });
    expect(readSpsColor("avc", made)).toMatchObject({ primaries: 0, transfer: 0, matrix: 1 });
    // No 00 00 {00,01,02} run survives in the payload, and an escape byte
    // is never followed by a byte that would need another one.
    const p = made.subarray(1);
    for (let i = 2; i < p.length; i++) {
      expect(p[i - 2] === 0 && p[i - 1] === 0 && p[i] <= 2).toBe(false);
      if (p[i - 2] === 0 && p[i - 1] === 0 && p[i] === 3 && i + 1 < p.length) expect(p[i + 1] <= 3).toBe(true);
    }
  });
});

/** An HEVC SPS RBSP with sub-layers, scaling lists, inter-predicted
 * reference sets and long-term pictures — the shape phone encoders write. */
function hevcSps(opts: { subLayers: number; scaling: boolean; vui: boolean }): Uint8Array {
  const w = new BitWriter();
  w.u(0, 4);
  w.u(opts.subLayers, 3);
  w.u(1, 1);
  w.u(0, 2);
  w.u(0, 1);
  w.u(1, 5);
  w.u(0x60000000, 32);
  w.u(0, 48);
  w.u(120, 8);
  for (let i = 0; i < opts.subLayers; i++) {
    w.u(1, 1);
    w.u(1, 1);
  }
  if (opts.subLayers > 0) for (let i = opts.subLayers; i < 8; i++) w.u(0, 2);
  for (let i = 0; i < opts.subLayers; i++) {
    w.u(0, 88);
    w.u(90, 8);
  }
  w.ue(0);
  w.ue(1);
  w.ue(1920);
  w.ue(1080);
  w.u(1, 1);
  w.ue(0);
  w.ue(0);
  w.ue(0);
  w.ue(4);
  w.ue(0);
  w.ue(0);
  w.ue(4); // log2_max_poc_lsb_minus4 → 8 bits
  w.u(1, 1);
  for (let i = 0; i <= opts.subLayers; i++) {
    w.ue(4);
    w.ue(2);
    w.ue(0);
  }
  w.ue(0);
  w.ue(3);
  w.ue(0);
  w.ue(3);
  w.ue(1);
  w.ue(1);
  w.u(opts.scaling ? 1 : 0, 1);
  if (opts.scaling) {
    w.u(1, 1);
    for (let sizeId = 0; sizeId < 4; sizeId++) {
      for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
        if (matrixId % 2) {
          w.u(0, 1);
          w.ue(0);
          continue;
        }
        w.u(1, 1);
        const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
        if (sizeId > 1) w.se(2);
        for (let i = 0; i < coefNum; i++) w.se(i % 3 === 0 ? 1 : -1);
      }
    }
  }
  w.u(1, 1);
  w.u(1, 1);
  w.u(1, 1); // pcm
  w.u(7, 4);
  w.u(7, 4);
  w.ue(0);
  w.ue(2);
  w.u(1, 1);
  // three short-term sets: explicit, explicit, inter-predicted from the second
  w.ue(3);
  w.ue(2); // set 0: two negative, one positive
  w.ue(1);
  w.ue(0);
  w.u(1, 1);
  w.ue(1);
  w.u(1, 1);
  w.ue(0);
  w.u(1, 1);
  w.u(0, 1); // set 1: explicit, one negative
  w.ue(1);
  w.ue(0);
  w.ue(3);
  w.u(1, 1);
  w.u(1, 1); // set 2: inter from set 1 (delta idx 1), deltaRps = -2
  w.u(1, 1);
  w.ue(1);
  w.u(1, 1); // used j=0
  w.u(0, 1); // not used j=1 → use_delta_flag
  w.u(1, 1);
  w.u(1, 1); // long-term
  w.ue(2);
  w.u(17, 8);
  w.u(1, 1);
  w.u(33, 8);
  w.u(0, 1);
  w.u(1, 1);
  w.u(1, 1);
  w.u(opts.vui ? 1 : 0, 1);
  if (opts.vui) {
    w.u(1, 1);
    w.u(1, 8);
    w.u(0, 1);
    w.u(1, 1); // signal
    w.u(5, 3);
    w.u(0, 1);
    w.u(1, 1);
    w.u(9, 8);
    w.u(18, 8);
    w.u(9, 8);
    w.u(0, 1); // chroma loc
    w.u(0, 1);
    w.u(0, 1);
    w.u(0, 1);
    w.u(0, 1); // default display window
    w.u(1, 1); // timing
    w.u(1001, 32);
    w.u(60000, 32);
    w.u(0, 1);
    w.u(0, 1);
    w.u(0, 1); // bitstream restriction
  }
  w.u(0, 1); // sps_extension_present_flag
  w.trailing();
  return new Uint8Array([0x42, 0x01, ...escapeRbsp(w.toBytes())]);
}

describe("HEVC SPS shapes", () => {
  for (const [name, nal] of [
    ["two sub-layers, scaling lists, inter RPS, long-term, VUI", hevcSps({ subLayers: 2, scaling: true, vui: true })],
    ["no sub-layers, no scaling, VUI", hevcSps({ subLayers: 0, scaling: false, vui: true })],
    ["no VUI", hevcSps({ subLayers: 1, scaling: true, vui: false })],
  ] as [string, Uint8Array][]) {
    test(name, () => {
      const before = readSpsColor("hevc", nal);
      const made = rewriteSpsColor("hevc", nal, NEUTRAL);
      expect(readSpsColor("hevc", made)).toEqual({ videoFormat: 5, primaries: 1, transfer: 13, matrix: 1, fullRange: false });
      if (before) expect(tailBits("hevc", made)).toBe(tailBits("hevc", nal));
      expect(hex(rewriteSpsColor("hevc", made, NEUTRAL))).toBe(hex(made));
    });
  }
});
