/**
 * Rewriting the color tags an H.264 / HEVC bitstream carries.
 *
 * A hardware decoder reads the picture's color from the sequence parameter
 * set's VUI, and a browser converts the decoded frame by those tags before
 * anything can draw it: an HLG file is tone-mapped, a wide-gamut one is gamut
 * mapped. The decoder config's `colorSpace` does not override them. So when
 * the preview needs code values untouched, the tags in the bitstream are
 * rewritten to Rec.709 / sRGB before the decoder sees them — the same
 * operation ffmpeg's `h264_metadata` / `hevc_metadata` filters perform — and
 * the grade pipeline applies the file's real meaning from the asset's
 * `color`.
 *
 * The rewrite parses the SPS up to the VUI, replaces (or inserts) the video
 * signal fields, and copies every bit after them unchanged, so the parameter
 * set stays exactly what the encoder wrote apart from the three tags and the
 * range flag. It runs on the codec description (avcC / hvcC) once per
 * decoder, and on in-band parameter sets when a sample carries them, cached
 * by their bytes so a repeated SPS costs one lookup.
 */

export interface SpsColorTags {
  /** colour_primaries, H.273 code. */
  primaries: number;
  /** transfer_characteristics, H.273 code. */
  transfer: number;
  /** matrix_coefficients, H.273 code. */
  matrix: number;
  fullRange: boolean;
}

/** Rec.709 primaries, sRGB transfer, Rec.709 matrix: the tags a browser
 * draws without converting. */
export const NEUTRAL_TAGS = (fullRange: boolean): SpsColorTags => ({
  primaries: 1,
  transfer: 13,
  matrix: 1,
  fullRange,
});

export type SpsCodec = "avc" | "hevc";

const PRIMARIES_CODE: Record<string, number> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9 };
const TRANSFER_CODE: Record<string, number> = { bt709: 1, smpte170m: 6, linear: 8, "iec61966-2-1": 13, pq: 16, hlg: 18 };
const MATRIX_CODE: Record<string, number> = { rgb: 0, bt709: 1, bt470bg: 5, smpte170m: 6, "bt2020-ncl": 9 };

/** The VUI codes a WebCodecs color space init spells; a field it leaves out
 * stays unspecified (2), the code a decoder reads as "no information". */
export function tagsOfColorSpace(cs: VideoColorSpaceInit): SpsColorTags {
  return {
    primaries: (cs.primaries && PRIMARIES_CODE[cs.primaries]) ?? 2,
    transfer: (cs.transfer && TRANSFER_CODE[cs.transfer]) ?? 2,
    matrix: (cs.matrix && MATRIX_CODE[cs.matrix]) ?? 2,
    fullRange: cs.fullRange ?? false,
  };
}

/** The rewriter's codec for a WebCodecs codec string; null for a codec whose
 * color tags live outside an SPS. */
export function spsCodecOf(codec: string): SpsCodec | null {
  if (codec.startsWith("avc1") || codec.startsWith("avc3")) return "avc";
  if (codec.startsWith("hev1") || codec.startsWith("hvc1")) return "hevc";
  return null;
}

/* ------------------------------------------------------------------ */
/* Bits                                                                */
/* ------------------------------------------------------------------ */

export class BitReader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get length(): number {
    return this.bytes.length * 8;
  }
  bit(): number {
    if (this.pos >= this.length) throw new RangeError("SPS ended early.");
    const b = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 32) throw new RangeError("Bad Exp-Golomb code.");
    }
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.u(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
  skip(n: number): void {
    this.pos += n;
    if (this.pos > this.length) throw new RangeError("SPS ended early.");
  }
}

export class BitWriter {
  private bits: number[] = [];
  u(value: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) & 1);
  }
  ue(value: number): void {
    const v = value + 1;
    const len = 32 - Math.clz32(v);
    this.u(0, len - 1);
    this.u(v, len);
  }
  se(value: number): void {
    this.ue(value > 0 ? 2 * value - 1 : -2 * value);
  }
  /** Append bits [from, to) of `bytes`. */
  copy(bytes: Uint8Array, from: number, to: number): void {
    for (let p = from; p < to; p++) this.bits.push((bytes[p >> 3] >> (7 - (p & 7))) & 1);
  }
  /** RBSP trailing bits: a stop bit and zeros to the byte. */
  trailing(): void {
    this.bits.push(1);
    while (this.bits.length & 7) this.bits.push(0);
  }
  get length(): number {
    return this.bits.length;
  }
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) if (this.bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
    return out;
  }
}

/** The bit index of the RBSP stop bit: the last 1 in the payload. */
function stopBit(rbsp: Uint8Array): number {
  for (let i = rbsp.length - 1; i >= 0; i--) {
    const b = rbsp[i];
    if (b === 0) continue;
    for (let k = 0; k < 8; k++) if ((b >> k) & 1) return i * 8 + (7 - k);
  }
  throw new RangeError("No RBSP stop bit.");
}

/** Remove emulation prevention bytes from a NAL payload. */
export function unescapeRbsp(payload: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 0; i < payload.length; i++) {
    const b = payload[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

/** Insert emulation prevention bytes so no 00 00 0x (x ≤ 3) sequence
 * appears in the payload. */
export function escapeRbsp(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (let i = 0; i < rbsp.length; i++) {
    const b = rbsp[i];
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------------ */
/* Parsing to the VUI                                                  */
/* ------------------------------------------------------------------ */

/** Where the video signal fields sit in an SPS RBSP, in bits. */
interface VuiSpot {
  /** vui_parameters_present_flag. */
  vuiFlag: number;
  vuiPresent: boolean;
  /** video_signal_type_present_flag, when the VUI is present. */
  signal: number;
  /** First bit after the video signal block (or after the flag when 0). */
  resume: number;
  /** The tags the SPS carries, when it carries them. */
  tags: (SpsColorTags & { videoFormat: number }) | null;
}

const AVC_HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function readAvcScalingList(r: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) {
      const delta = r.se();
      next = (last + delta + 256) % 256;
    }
    last = next === 0 ? last : next;
  }
}

function readVideoSignal(r: BitReader): VuiSpot["tags"] {
  const videoFormat = r.u(3);
  const fullRange = r.bit() === 1;
  const described = r.bit() === 1;
  if (!described) return { videoFormat, fullRange, primaries: 2, transfer: 2, matrix: 2 };
  return { videoFormat, fullRange, primaries: r.u(8), transfer: r.u(8), matrix: r.u(8) };
}

/** Aspect ratio and overscan, then the signal block: shared by both VUIs. */
function readVuiHead(r: BitReader, vuiFlag: number, vuiPresent: boolean): VuiSpot {
  if (!vuiPresent) return { vuiFlag, vuiPresent, signal: -1, resume: vuiFlag + 1, tags: null };
  if (r.bit()) {
    const idc = r.u(8);
    if (idc === 255) r.skip(32);
  }
  if (r.bit()) r.skip(1);
  const signal = r.pos;
  const present = r.bit() === 1;
  const tags = present ? readVideoSignal(r) : null;
  return { vuiFlag, vuiPresent, signal, resume: r.pos, tags };
}

function locateAvcVui(rbsp: Uint8Array): VuiSpot {
  const r = new BitReader(rbsp);
  const profile = r.u(8);
  r.skip(16); // constraint flags, level
  r.ue(); // sps id
  let chroma = 1;
  if (AVC_HIGH_PROFILES.has(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.skip(1);
    r.ue();
    r.ue();
    r.skip(1);
    if (r.bit()) {
      const lists = chroma !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) if (r.bit()) readAvcScalingList(r, i < 6 ? 16 : 64);
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.skip(1);
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.skip(1);
  r.ue();
  r.ue();
  if (!r.bit()) r.skip(1); // frame_mbs_only_flag → mb_adaptive_frame_field_flag
  r.skip(1); // direct_8x8_inference_flag
  if (r.bit()) for (let i = 0; i < 4; i++) r.ue(); // cropping
  const vuiFlag = r.pos;
  const vuiPresent = r.bit() === 1;
  return readVuiHead(r, vuiFlag, vuiPresent);
}

interface RefPicSet {
  s0: number[];
  s1: number[];
}

function readStRefPicSet(r: BitReader, idx: number, count: number, sets: RefPicSet[]): RefPicSet {
  const inter = idx !== 0 && r.bit() === 1;
  if (inter) {
    const deltaIdx = idx === count ? r.ue() + 1 : 1;
    const sign = r.bit();
    const deltaRps = (1 - 2 * sign) * (r.ue() + 1);
    const ref = sets[idx - deltaIdx];
    const numDelta = ref.s0.length + ref.s1.length;
    const useDelta: boolean[] = [];
    for (let j = 0; j <= numDelta; j++) {
      const used = r.bit() === 1;
      useDelta.push(used ? true : r.bit() === 1);
    }
    const s0: number[] = [];
    const s1: number[] = [];
    for (let j = ref.s1.length - 1; j >= 0; j--) {
      const d = ref.s1[j] + deltaRps;
      if (d < 0 && useDelta[ref.s0.length + j]) s0.push(d);
    }
    if (deltaRps < 0 && useDelta[numDelta]) s0.push(deltaRps);
    for (let j = 0; j < ref.s0.length; j++) {
      const d = ref.s0[j] + deltaRps;
      if (d < 0 && useDelta[j]) s0.push(d);
    }
    for (let j = ref.s0.length - 1; j >= 0; j--) {
      const d = ref.s0[j] + deltaRps;
      if (d > 0 && useDelta[j]) s1.push(d);
    }
    if (deltaRps > 0 && useDelta[numDelta]) s1.push(deltaRps);
    for (let j = 0; j < ref.s1.length; j++) {
      const d = ref.s1[j] + deltaRps;
      if (d > 0 && useDelta[ref.s0.length + j]) s1.push(d);
    }
    return { s0, s1 };
  }
  const numNeg = r.ue();
  const numPos = r.ue();
  const s0: number[] = [];
  const s1: number[] = [];
  let poc = 0;
  for (let j = 0; j < numNeg; j++) {
    poc -= r.ue() + 1;
    r.skip(1);
    s0.push(poc);
  }
  poc = 0;
  for (let j = 0; j < numPos; j++) {
    poc += r.ue() + 1;
    r.skip(1);
    s1.push(poc);
  }
  return { s0, s1 };
}

function readHevcScalingListData(r: BitReader): void {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      if (!r.bit()) {
        r.ue();
        continue;
      }
      let next = 8;
      const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
      if (sizeId > 1) next = r.se() + 8;
      for (let i = 0; i < coefNum; i++) next = (next + r.se() + 256) % 256;
    }
  }
}

function locateHevcVui(rbsp: Uint8Array): VuiSpot {
  const r = new BitReader(rbsp);
  r.skip(4); // vps id
  const maxSubLayersMinus1 = r.u(3);
  r.skip(1); // temporal id nesting
  // profile_tier_level
  r.skip(2 + 1 + 5 + 32 + 48 + 8);
  const subProfile: boolean[] = [];
  const subLevel: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subProfile.push(r.bit() === 1);
    subLevel.push(r.bit() === 1);
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.skip(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subProfile[i]) r.skip(88);
    if (subLevel[i]) r.skip(8);
  }
  r.ue(); // sps id
  const chroma = r.ue();
  if (chroma === 3) r.skip(1);
  r.ue();
  r.ue();
  if (r.bit()) for (let i = 0; i < 4; i++) r.ue(); // conformance window
  r.ue();
  r.ue();
  const log2MaxPocLsb = r.ue() + 4;
  const orderingInfo = r.bit() === 1;
  for (let i = orderingInfo ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
    r.ue();
    r.ue();
    r.ue();
  }
  for (let i = 0; i < 6; i++) r.ue();
  if (r.bit() && r.bit()) readHevcScalingListData(r);
  r.skip(2); // amp, sao
  if (r.bit()) {
    r.skip(8);
    r.ue();
    r.ue();
    r.skip(1);
  }
  const numSets = r.ue();
  const sets: RefPicSet[] = [];
  for (let i = 0; i < numSets; i++) sets.push(readStRefPicSet(r, i, numSets, sets));
  if (r.bit()) {
    const n = r.ue();
    for (let i = 0; i < n; i++) {
      r.skip(log2MaxPocLsb);
      r.skip(1);
    }
  }
  r.skip(2); // temporal mvp, strong intra smoothing
  const vuiFlag = r.pos;
  const vuiPresent = r.bit() === 1;
  return readVuiHead(r, vuiFlag, vuiPresent);
}

/* ------------------------------------------------------------------ */
/* Rewriting                                                           */
/* ------------------------------------------------------------------ */

const HEADER_BYTES: Record<SpsCodec, number> = { avc: 1, hevc: 2 };

/** The color tags an SPS NAL (header included) carries, or null when its
 * VUI has no video signal block. */
export function readSpsColor(codec: SpsCodec, nal: Uint8Array): (SpsColorTags & { videoFormat: number }) | null {
  const rbsp = unescapeRbsp(nal.subarray(HEADER_BYTES[codec]));
  const spot = codec === "avc" ? locateAvcVui(rbsp) : locateHevcVui(rbsp);
  return spot.tags;
}

/** The same SPS NAL carrying `tags`. The header, every field before the
 * video signal block and every bit after it are kept as they were. */
export function rewriteSpsColor(codec: SpsCodec, nal: Uint8Array, tags: SpsColorTags): Uint8Array {
  const header = HEADER_BYTES[codec];
  const rbsp = unescapeRbsp(nal.subarray(header));
  const spot = codec === "avc" ? locateAvcVui(rbsp) : locateHevcVui(rbsp);
  const stop = stopBit(rbsp);
  const w = new BitWriter();
  if (spot.vuiPresent) {
    w.copy(rbsp, 0, spot.signal);
  } else {
    w.copy(rbsp, 0, spot.vuiFlag);
    w.u(1, 1); // vui_parameters_present_flag
    w.u(0, 1); // aspect_ratio_info_present_flag
    w.u(0, 1); // overscan_info_present_flag
  }
  w.u(1, 1); // video_signal_type_present_flag
  w.u(spot.tags?.videoFormat ?? 5, 3);
  w.u(tags.fullRange ? 1 : 0, 1);
  w.u(1, 1); // colour_description_present_flag
  w.u(tags.primaries, 8);
  w.u(tags.transfer, 8);
  w.u(tags.matrix, 8);
  if (!spot.vuiPresent) {
    w.u(0, 1); // chroma_loc_info_present_flag
    if (codec === "avc") {
      // timing, nal hrd, vcl hrd, pic_struct, bitstream restriction
      w.u(0, 5);
    } else {
      // neutral chroma, field seq, frame field info, default display
      // window, timing, bitstream restriction
      w.u(0, 6);
    }
  }
  w.copy(rbsp, spot.resume, stop);
  w.trailing();
  const payload = escapeRbsp(w.toBytes());
  const result = new Uint8Array(header + payload.length);
  result.set(nal.subarray(0, header), 0);
  result.set(payload, header);
  return result;
}

const nalType = (codec: SpsCodec, nal: Uint8Array): number =>
  codec === "avc" ? nal[0] & 0x1f : (nal[0] >> 1) & 0x3f;
const SPS_TYPE: Record<SpsCodec, number> = { avc: 7, hevc: 33 };

/** Rewrites parameter sets once per distinct SPS: the same bytes come back
 * from the cache. One per decoder, so a stream's handful of SPS live here. */
export class SpsColorRewriter {
  private readonly cache = new Map<string, Uint8Array>();
  constructor(
    readonly codec: SpsCodec,
    readonly tags: SpsColorTags
  ) {}

  sps(nal: Uint8Array): Uint8Array {
    let key = "";
    for (let i = 0; i < nal.length; i++) key += String.fromCharCode(nal[i]);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const made = rewriteSpsColor(this.codec, nal, this.tags);
    this.cache.set(key, made);
    return made;
  }

  /** The codec description (avcC or hvcC) with its SPS entries rewritten. */
  description(desc: Uint8Array): Uint8Array {
    return this.codec === "avc" ? this.avcC(desc) : this.hvcC(desc);
  }

  /** Length-prefixed sample data with any in-band SPS rewritten; null when
   * the sample carries none, so the caller keeps its packet. */
  sample(data: Uint8Array, lengthSize: number): Uint8Array | null {
    const parts: Uint8Array[] = [];
    let changed = false;
    let at = 0;
    while (at + lengthSize <= data.length) {
      let len = 0;
      for (let i = 0; i < lengthSize; i++) len = len * 256 + data[at + i];
      const start = at + lengthSize;
      const end = Math.min(data.length, start + len);
      if (end <= start) break;
      const nal = data.subarray(start, end);
      if (nalType(this.codec, nal) === SPS_TYPE[this.codec]) {
        const made = this.sps(nal);
        if (made !== nal) {
          changed = true;
          parts.push(lengthPrefix(made.length, lengthSize), made);
          at = end;
          continue;
        }
      }
      parts.push(data.subarray(at, end));
      at = end;
    }
    if (!changed) return null;
    if (at < data.length) parts.push(data.subarray(at));
    return concat(parts);
  }

  private avcC(desc: Uint8Array): Uint8Array {
    const parts: Uint8Array[] = [desc.subarray(0, 6)];
    let at = 6;
    const numSps = desc[5] & 0x1f;
    for (let i = 0; i < numSps; i++) {
      const len = (desc[at] << 8) | desc[at + 1];
      const made = this.sps(desc.subarray(at + 2, at + 2 + len));
      parts.push(lengthPrefix(made.length, 2), made);
      at += 2 + len;
    }
    parts.push(desc.subarray(at));
    return concat(parts);
  }

  private hvcC(desc: Uint8Array): Uint8Array {
    const parts: Uint8Array[] = [desc.subarray(0, 23)];
    const numArrays = desc[22];
    let at = 23;
    for (let a = 0; a < numArrays; a++) {
      const type = desc[at] & 0x3f;
      const count = (desc[at + 1] << 8) | desc[at + 2];
      parts.push(desc.subarray(at, at + 3));
      at += 3;
      for (let i = 0; i < count; i++) {
        const len = (desc[at] << 8) | desc[at + 1];
        const nal = desc.subarray(at + 2, at + 2 + len);
        const made = type === SPS_TYPE.hevc ? this.sps(nal) : nal;
        parts.push(lengthPrefix(made.length, 2), made);
        at += 2 + len;
      }
    }
    parts.push(desc.subarray(at));
    return concat(parts);
  }
}

/** NAL length size (1–4) a description declares. */
export function descriptionLengthSize(codec: SpsCodec, desc: Uint8Array): number {
  return (codec === "avc" ? desc[4] & 3 : desc[21] & 3) + 1;
}

function lengthPrefix(length: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    out[i] = length & 0xff;
    length >>>= 8;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
