import { describe, expect, test } from "bun:test";
import { decodeYcc } from "@donkeycut/effects-kit";
import { convertPlanes, isPlanarFormat, planesPassThrough, proxySize, type PlanarFormat } from "./proxyPlanes";

/** A flat frame of one Y'CbCr triple in `format`, planes packed tight. */
function flat(format: PlanarFormat, width: number, height: number, y: number, cb: number, cr: number) {
  const hs = format.startsWith("I444") ? 0 : 1;
  const vs = format.startsWith("I420") ? 1 : 0;
  const cw = (width + (1 << hs) - 1) >> hs;
  const ch = (height + (1 << vs) - 1) >> vs;
  const data = new ArrayBuffer((width * height + 2 * cw * ch) * 2);
  const u16 = new Uint16Array(data);
  u16.fill(y, 0, width * height);
  u16.fill(cb, width * height, width * height + cw * ch);
  u16.fill(cr, width * height + cw * ch);
  return {
    format,
    width,
    height,
    data,
    layout: [
      { offset: 0, stride: width * 2 },
      { offset: width * height * 2, stride: cw * 2 },
      { offset: (width * height + cw * ch) * 2, stride: cw * 2 },
    ],
  };
}

/** R'G'B' of a code triple at `depth` bits: BT.2100's scaling — limited
 * range on 16..235 / 16..240 times 2^(d-8), full range on 0..2^d-1 with
 * chroma centered on 2^(d-1). */
function rgbOf(matrix: "bt709" | "bt601" | "bt2020nc", fullRange: boolean, depth: number, y: number, cb: number, cr: number) {
  const scale = 1 << (depth - 8);
  const [yn, cbn, crn] = fullRange
    ? [y / ((1 << depth) - 1), (cb - (1 << (depth - 1))) / ((1 << depth) - 1), (cr - (1 << (depth - 1))) / ((1 << depth) - 1)]
    : [(y - 16 * scale) / (219 * scale), (cb - 128 * scale) / (224 * scale), (cr - 128 * scale) / (224 * scale)];
  // decodeYcc takes 8-bit-scaled limited code values; hand it the same
  // normalized numbers by re-encoding them on that scale.
  return decodeYcc({ matrix, fullRange: false }, (16 + 219 * yn) / 255, (128 + 224 * cbn) / 255, (128 + 224 * crn) / 255);
}

describe("proxy planes", () => {
  test("knows the decoder's 10- and 12-bit planar formats", () => {
    expect(isPlanarFormat("I422P10")).toBe(true);
    expect(isPlanarFormat("I420")).toBe(false);
    expect(isPlanarFormat("RGBA")).toBe(false);
    const fits = { width: 1920, height: 1080, maxHeight: 2160 };
    expect(planesPassThrough("I420P10", { matrix: "bt709", fullRange: false }, fits)).toBe(true);
    expect(planesPassThrough("I422P10", { matrix: "bt709", fullRange: false }, fits)).toBe(false);
    expect(planesPassThrough("I420P10", { matrix: "bt2020nc", fullRange: false }, fits)).toBe(false);
    expect(planesPassThrough("I420P10", { matrix: "bt709", fullRange: false }, { ...fits, maxHeight: 720 })).toBe(false);
    expect(planesPassThrough("I420P10", { matrix: "bt709", fullRange: false }, { width: 1921, height: 1080, maxHeight: 2160 })).toBe(false);
  });

  test("carries a BT.2020 4:2:2 picture into Rec.709 limited 4:2:0 at the same RGB", () => {
    const [y, cb, cr] = [543, 366, 634];
    const out = convertPlanes(flat("I422P10", 8, 4, y, cb, cr), { matrix: "bt2020nc", fullRange: false });
    expect(out.format).toBe("I420P10");
    const u16 = new Uint16Array(out.data);
    const oy = u16[0], ocb = u16[out.layout[1].offset / 2], ocr = u16[out.layout[2].offset / 2];
    expect(ocb).not.toBe(cb);
    const want = rgbOf("bt2020nc", false, 10, y, cb, cr);
    const got = rgbOf("bt709", false, 10, oy, ocb, ocr);
    for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - want[c]) * 1023).toBeLessThan(1.5);
    // Flat in, flat out.
    expect(new Set(u16.subarray(0, 32))).toEqual(new Set([oy]));
  });

  test("brings a full-range 12-bit 4:4:4 picture down to 10-bit limited", () => {
    const [y, cb, cr] = [3000, 1200, 2600];
    const out = convertPlanes(flat("I444P12", 4, 4, y, cb, cr), { matrix: "bt709", fullRange: true });
    const u16 = new Uint16Array(out.data);
    const want = rgbOf("bt709", true, 12, y, cb, cr);
    const got = rgbOf("bt709", false, 10, u16[0], u16[out.layout[1].offset / 2], u16[out.layout[2].offset / 2]);
    for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - want[c]) * 1023).toBeLessThan(1.5);
    expect(u16[0]).toBeGreaterThanOrEqual(64);
    expect(u16[0]).toBeLessThanOrEqual(940);
  });

  test("averages chroma over each 2×2 block", () => {
    const frame = flat("I444P10", 2, 2, 512, 512, 512);
    const u16 = new Uint16Array(frame.data);
    // Cb: 400, 600 on the top row, 400, 600 below → 500.
    u16.set([400, 600, 400, 600], 4);
    const out = convertPlanes(frame, { matrix: "bt709", fullRange: false });
    const o = new Uint16Array(out.data);
    expect(o.length).toBe(4 + 1 + 1);
    expect(Math.abs(o[4] - 500)).toBeLessThanOrEqual(1);
  });

  test("sizes the proxy no taller than the cap, aspect kept, both sides even", () => {
    expect(proxySize(3840, 2160, 2160)).toEqual({ width: 3840, height: 2160 });
    expect(proxySize(3840, 2160, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(proxySize(2160, 3840, 1080)).toEqual({ width: 608, height: 1080 });
    expect(proxySize(1001, 563, 2160)).toEqual({ width: 1000, height: 562 });
    expect(proxySize(4096, 2160, 1000)).toEqual({ width: 1896, height: 1000 });
    expect(proxySize(3, 3, 1080)).toEqual({ width: 2, height: 2 });
  });

  test("brings a taller master down with an area filter: means over the boxes each output pixel covers", () => {
    // 8×8 luma: the left half at 400, the right at 800, 4:2:0 neutral chroma.
    const frame = flat("I420P10", 8, 8, 400, 512, 512);
    const u16 = new Uint16Array(frame.data);
    for (let y = 0; y < 8; y++) for (let x = 4; x < 8; x++) u16[y * 8 + x] = 800;
    const out = convertPlanes(frame, { matrix: "bt709", fullRange: false }, { maxHeight: 4 });
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    const o = new Uint16Array(out.data);
    expect(o.length).toBe(16 + 4 + 4);
    // Whole boxes: 2×2 of one value.
    expect(o[0]).toBe(400);
    expect(o[3]).toBe(800);
    expect(o[5]).toBe(400);
    expect(o[6]).toBe(800);
    // Chroma stays neutral.
    expect(o[16]).toBe(512);
    expect(o[20]).toBe(512);

    // A 3:1 ratio: 6 rows into 2, so the second output row averages rows 3..5.
    const tall = flat("I444P10", 2, 6, 100, 512, 512);
    const t = new Uint16Array(tall.data);
    for (let y = 3; y < 6; y++) for (let x = 0; x < 2; x++) t[y * 2 + x] = 700;
    const down = convertPlanes(tall, { matrix: "bt709", fullRange: false }, { maxHeight: 2 });
    expect(down.height).toBe(2);
    const d = new Uint16Array(down.data);
    expect(d[0]).toBe(100);
    expect(d[2]).toBe(700);

    // A fractional ratio: 5 columns into 2 — the middle column splits half and half.
    const wide = flat("I444P10", 5, 2, 200, 512, 512);
    const w = new Uint16Array(wide.data);
    for (let y = 0; y < 2; y++) for (let x = 3; x < 5; x++) w[y * 5 + x] = 600;
    for (let y = 0; y < 2; y++) w[y * 5 + 2] = 400;
    // The height fits, so the frame is only evened: 5×2 → 4×2.
    const evened = convertPlanes(wide, { matrix: "bt709", fullRange: false }, { maxHeight: 2 });
    expect([evened.width, evened.height]).toEqual([4, 2]);
    const e = new Uint16Array(evened.data);
    // Column 0 covers 0..1.25: 200; column 3 covers 3.75..5: 600.
    expect(e[0]).toBe(200);
    expect(e[3]).toBe(600);
    // Column 1 covers 1.25..2.5: 0.75 of 200 and 0.5 of 400 → 280.
    expect(Math.abs(e[1] - 280)).toBeLessThanOrEqual(1);
  });

  test("a scaled BT.2020 picture still lands on the same RGB", () => {
    const [y, cb, cr] = [543, 366, 634];
    const out = convertPlanes(flat("I422P10", 16, 8, y, cb, cr), { matrix: "bt2020nc", fullRange: false }, { maxHeight: 4 });
    expect([out.width, out.height]).toEqual([8, 4]);
    const u16 = new Uint16Array(out.data);
    const want = rgbOf("bt2020nc", false, 10, y, cb, cr);
    const got = rgbOf("bt709", false, 10, u16[0], u16[out.layout[1].offset / 2], u16[out.layout[2].offset / 2]);
    for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - want[c]) * 1023).toBeLessThan(1.5);
  });
});
