/**
 * What color a video file's header says its code values mean.
 *
 * A source's color is settled from its container alone: the sample entry's
 * `colr` atom names the primaries, transfer and matrix and whether the
 * range is full, the codec configuration names the bit depth, and Apple Log
 * footage carries a log identifier string in the movie's metadata. The probe
 * walks the atom tree by their headers and reads the payloads of only the
 * atoms that can carry those: the video track's sample description, and the
 * metadata and user-data atoms of the movie and that track. The sample
 * tables — the bulk of a long movie's header — are stepped over unread. The
 * bytes come in blocks, so a typical file costs two ranged reads and no
 * decode, and the probe runs the same over a dropped File, a URL and a file
 * handle.
 *
 * Anything that is not a MOV/MP4 — a WebM recording, a Matroska file — reads
 * as Rec.709 8-bit limited, which is what such files carry.
 *
 * The matrix decides whether a file is HDR. Social apps transcode phone
 * footage to 8-bit H.264 through the Rec.709 matrix and keep the source's
 * BT.2020 / HLG tags; those files are SDR, so an HLG or PQ transfer reads as
 * HDR only beside a BT.2020 matrix (or an unspecified one on BT.2020
 * primaries).
 */

import type { CodeFormat, SourceProfile } from "@donkeycut/effects-kit";

/** Read `length` bytes at `offset`; fewer come back at the end of the file. */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

export interface ColorProbe {
  code: CodeFormat;
  /** The profile the header settles on. */
  detected: SourceProfile;
  /** The video sample entry's four-character code (avc1, hvc1, apch, …);
   * "" when the header has no video. */
  codec: string;
}

export const DEFAULT_COLOR: ColorProbe = {
  code: { matrix: "bt709", fullRange: false, bitDepth: 8 },
  detected: "rec709",
  codec: "",
};

/** Bytes fetched per block. The top-level walk usually finds `ftyp`, the
 * data box's header and, in a fast-start file, the whole movie header in the
 * first one. */
const BLOCK = 64 * 1024;
/** A movie header up to this size is fetched in one read as soon as its
 * header is seen; a longer one — hours of footage, megabytes of sample
 * tables — is read block by block, and only where the walk lands. */
const MOOV_PREFETCH = 512 * 1024;
/** The most of any one metadata or sample-description atom scanned for the
 * log identifiers. Those atoms are a few kilobytes; past this the rest is
 * something else (cover art, a thumbnail track). */
const SCAN_MAX = 64 * 1024;
/** Atoms visited before the walk gives up on a malformed file. */
const MAX_ATOMS = 4096;

/** Identifier strings Apple writes into the movie metadata of log footage. */
const APPLE_LOG_2 = "com.apple.apple-wide-gamut.apple-log";
const APPLE_LOG = "com.apple.rec2020.apple-log";
const APPLE_CUSTOM_GAMMA = "com.apple.proapps.customgamma";

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u64 = (b: Uint8Array, at: number) => u32(b, at) * 2 ** 32 + u32(b, at + 4);

/** Ranged reads through a block cache: every byte is fetched once, in
 * BLOCK-aligned pieces, and a span read back comes out of the cache. */
class Blocks {
  private cache = new Map<number, Promise<Uint8Array>>();
  constructor(
    private read: ReadRange,
    /** The file's length, Infinity when unknown: the end is then wherever a
     * read comes back short. */
    readonly size: number
  ) {}

  /** Fetch `[offset, offset + length)` ahead in one read, into the cache. */
  prefetch(offset: number, length: number): void {
    let first = Math.floor(offset / BLOCK);
    const last = Math.floor((offset + Math.max(1, length) - 1) / BLOCK);
    while (first <= last && this.cache.has(first)) first++;
    if (first > last) return;
    const from = first * BLOCK;
    const whole = this.read(from, (last - first + 1) * BLOCK);
    for (let i = first; i <= last; i++) {
      if (this.cache.has(i)) continue;
      const at = (i - first) * BLOCK;
      const piece = whole.then((b) => b.subarray(Math.min(at, b.length), Math.min(at + BLOCK, b.length)));
      // A prefetched block the walk never reaches must not surface a failed
      // read as unhandled; one it does reach rejects there.
      piece.catch(() => {});
      this.cache.set(i, piece);
    }
  }

  private block(i: number): Promise<Uint8Array> {
    let p = this.cache.get(i);
    if (!p) {
      p = this.read(i * BLOCK, BLOCK);
      this.cache.set(i, p);
    }
    return p;
  }

  /** The bytes of `[offset, offset + length)` that the file holds; fewer at
   * its end. */
  async bytes(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(offset + length, this.size);
    if (end <= offset) return new Uint8Array(0);
    const first = Math.floor(offset / BLOCK);
    const last = Math.floor((end - 1) / BLOCK);
    if (first === last) {
      const b = await this.block(first);
      const from = offset - first * BLOCK;
      return b.subarray(Math.min(from, b.length), Math.min(end - first * BLOCK, b.length));
    }
    const out = new Uint8Array(end - offset);
    let filled = 0;
    for (let i = first; i <= last; i++) {
      const b = await this.block(i);
      const from = i === first ? offset - first * BLOCK : 0;
      const to = Math.min(b.length, end - i * BLOCK);
      if (to <= from) break;
      out.set(b.subarray(from, to), filled);
      filled += to - from;
      if (b.length < BLOCK) break;
    }
    return out.subarray(0, filled);
  }
}

interface Atom {
  type: string;
  /** File offset of the payload. */
  start: number;
  /** File offset one past the payload. */
  end: number;
}

/** The atoms of `[from, to)`, read header by header. An atom whose size lies
 * (too small, or running past the span) ends the walk: what follows is not
 * atoms. */
async function* atoms(blocks: Blocks, from: number, to: number, budget: { left: number }): AsyncGenerator<Atom> {
  let at = from;
  while (at + 8 <= to && budget.left-- > 0) {
    const head = await blocks.bytes(at, 16);
    if (head.length < 8) return;
    let size = u32(head, 0);
    let headLen = 8;
    if (size === 1) {
      if (head.length < 16) return;
      size = u64(head, 8);
      headLen = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < headLen || at + size > to) return;
    yield { type: ascii(head, 4), start: at + headLen, end: at + size };
    at += size;
  }
}

async function childAtom(blocks: Blocks, parent: Atom, type: string, budget: { left: number }): Promise<Atom | null> {
  for await (const c of atoms(blocks, parent.start, parent.end, budget)) if (c.type === type) return c;
  return null;
}

/** Whether the byte string `needle` occurs in `hay`. The search is over a
 * metadata atom's bytes — a technical container field. */
function contains(hay: Uint8Array, needle: string): boolean {
  const n = needle.length;
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i + n <= hay.length; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < n; j++) if (hay[i + j] !== needle.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

const MATRIX: Record<number, CodeFormat["matrix"]> = {
  1: "bt709",
  5: "bt601",
  6: "bt601",
  9: "bt2020nc",
};
/** colr's code for BT.2020 primaries, and for "unspecified". */
const BT2020 = 9;
const UNSPECIFIED = 2;

/** ProRes and other codecs whose depth is the four-character code. */
const CODEC_DEPTH: Record<string, number> = {
  apco: 10,
  apcs: 10,
  apcn: 10,
  apch: 10,
  ap4h: 12,
  ap4x: 12,
};

interface Box {
  type: string;
  /** Offset of the payload inside the buffer. */
  start: number;
  /** Offset one past the payload. */
  end: number;
}

/** Child boxes of the span `[from, to)` of an in-memory buffer. */
function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  let at = from;
  while (at + 8 <= to) {
    let size = u32(b, at);
    let head = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      size = u64(b, at + 8);
      head = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < head || at + size > to) return;
    yield { type: ascii(b, at + 4), start: at + head, end: at + size };
    at += size;
  }
}

function child(b: Uint8Array, box: Box, type: string): Box | null {
  for (const c of boxes(b, box.start, box.end)) if (c.type === type) return c;
  return null;
}

/** Bit depth from the codec configuration record inside a sample entry. */
function bitDepthOf(b: Uint8Array, entry: Box, format: string): number {
  const fixed = CODEC_DEPTH[format];
  if (fixed) return fixed;
  const hvcC = child(b, entry, "hvcC");
  // HEVCDecoderConfigurationRecord: bitDepthLumaMinus8 sits at byte 17.
  if (hvcC && hvcC.end - hvcC.start >= 18) return 8 + (b[hvcC.start + 17] & 0x07);
  const avcC = child(b, entry, "avcC");
  if (avcC) {
    // The depth fields follow the parameter sets, and only for the high
    // profiles (100, 110, 122, 144); the other profiles are 8-bit.
    const profile = b[avcC.start + 1];
    if (![100, 110, 122, 144].includes(profile)) return 8;
    let at = avcC.start + 5;
    const spsCount = b[at++] & 0x1f;
    for (let i = 0; i < spsCount && at + 2 <= avcC.end; i++) at += 2 + u16(b, at);
    if (at >= avcC.end) return 8;
    const ppsCount = b[at++];
    for (let i = 0; i < ppsCount && at + 2 <= avcC.end; i++) at += 2 + u16(b, at);
    if (at + 3 > avcC.end) return 8;
    return 8 + (b[at + 1] & 0x07);
  }
  const av1C = child(b, entry, "av1C");
  if (av1C && av1C.end - av1C.start >= 3) {
    const highBitdepth = (b[av1C.start + 2] >> 6) & 1;
    const twelveBit = (b[av1C.start + 2] >> 5) & 1;
    return highBitdepth ? (twelveBit ? 12 : 10) : 8;
  }
  const vpcC = child(b, entry, "vpcC");
  if (vpcC && vpcC.end - vpcC.start >= 6) return b[vpcC.start + 6] >> 4 || 8;
  return 8;
}

/** What the probe reads out of a movie header: the first video sample entry
 * (its payload, the fixed fields dropped) and the metadata bytes that can
 * name a log curve. */
interface MovieFacts {
  entry: { format: string; bytes: Uint8Array } | null;
  metadata: Uint8Array[];
}

/** Atoms whose payload can hold the log identifiers. */
const METADATA = new Set(["meta", "udta"]);

async function scan(blocks: Blocks, atom: Atom): Promise<Uint8Array> {
  return blocks.bytes(atom.start, Math.min(atom.end - atom.start, SCAN_MAX));
}

/** Walk `moov` for the facts, reading only the atoms that carry them. */
async function readMovie(blocks: Blocks, moov: Atom): Promise<MovieFacts> {
  const facts: MovieFacts = { entry: null, metadata: [] };
  const budget = { left: MAX_ATOMS };
  for await (const top of atoms(blocks, moov.start, moov.end, budget)) {
    if (METADATA.has(top.type)) {
      facts.metadata.push(await scan(blocks, top));
      continue;
    }
    if (top.type !== "trak" || facts.entry) continue;
    let isVideo = false;
    let stsd: Atom | null = null;
    const trakMeta: Atom[] = [];
    for await (const t of atoms(blocks, top.start, top.end, budget)) {
      if (METADATA.has(t.type)) trakMeta.push(t);
      if (t.type !== "mdia") continue;
      for await (const m of atoms(blocks, t.start, t.end, budget)) {
        if (m.type === "hdlr") {
          // Full box: version/flags (4), pre_defined (4), handler_type (4).
          const h = await blocks.bytes(m.start, 12);
          isVideo = h.length >= 12 && ascii(h, 8) === "vide";
          if (!isVideo) break;
        } else if (m.type === "minf" && isVideo) {
          const stbl = await childAtom(blocks, m, "stbl", budget);
          stsd = stbl ? await childAtom(blocks, stbl, "stsd", budget) : null;
        }
      }
    }
    if (!isVideo || !stsd) continue;
    // Full box header (4) + entry count (4), then the sample entries.
    const first = (await atoms(blocks, stsd.start + 8, stsd.end, budget).next()).value as Atom | undefined;
    // VisualSampleEntry: 78 bytes of fixed fields before the child boxes.
    if (first && first.end - first.start >= 78) {
      const bytes = await blocks.bytes(first.start + 78, Math.min(first.end - first.start - 78, SCAN_MAX));
      facts.entry = { format: first.type, bytes };
    }
    for (const a of trakMeta) facts.metadata.push(await scan(blocks, a));
  }
  return facts;
}

/** Settle a file's color from its header. `size` is the file's byte length,
 * when known; without it the walk ends where a read comes back short. */
export async function probeColor(readRange: ReadRange, size = Infinity): Promise<ColorProbe> {
  const blocks = new Blocks(readRange, size);
  const moov = await findMoov(blocks);
  if (!moov) return DEFAULT_COLOR;
  return colorOf(await readMovie(blocks, moov));
}

/** Walk the top-level atoms for `moov`. Null when the file is not an ISO
 * base media file or has no movie header in reach. Once the walk is within
 * reach of the end of a file of known length, the rest comes in one read:
 * that is where a camera writes the movie header. */
async function findMoov(blocks: Blocks): Promise<Atom | null> {
  let at = 0;
  for (let seen = 0; seen < 64 && at + 8 <= blocks.size; seen++) {
    if (blocks.size - at <= MOOV_PREFETCH) blocks.prefetch(at, blocks.size - at);
    const head = await blocks.bytes(at, 16);
    if (head.length < 8) return null;
    const type = ascii(head, 4);
    let size = u32(head, 0);
    let headLen = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = u64(head, 8);
      headLen = 16;
    } else if (size === 0) {
      size = blocks.size - at;
    }
    if (at === 0 && !["ftyp", "moov", "wide", "free", "mdat", "skip"].includes(type)) return null;
    if (size < headLen) return null;
    if (type === "moov") {
      // A header cut short by the file's end ends there: the atoms that run
      // past it are not read.
      const atom = { type, start: at + headLen, end: Math.min(at + size, blocks.size) };
      if (atom.end - atom.start <= MOOV_PREFETCH) blocks.prefetch(atom.start, atom.end - atom.start);
      return atom;
    }
    at += size;
  }
  return null;
}

/** The profile a sample entry's `colr` and the movie's metadata settle on. */
function colorOf(facts: MovieFacts): ColorProbe {
  if (!facts.entry) return DEFAULT_COLOR;
  const { format, bytes } = facts.entry;
  const entry: Box = { type: format, start: 0, end: bytes.length };
  let matrix: CodeFormat["matrix"] = "bt709";
  let fullRange = false;
  let transfer = 1;
  let hdrMatrix = false;
  for (const c of boxes(bytes, entry.start, entry.end)) {
    if (c.type !== "colr" || c.end - c.start < 10) continue;
    const kind = ascii(bytes, c.start);
    if (kind !== "nclx" && kind !== "nclc") continue;
    const primaries = u16(bytes, c.start + 4);
    transfer = u16(bytes, c.start + 6);
    const code = u16(bytes, c.start + 8);
    // An unspecified matrix on BT.2020 primaries is BT.2020's own.
    hdrMatrix = code === BT2020 || (code === UNSPECIFIED && primaries === BT2020);
    matrix = hdrMatrix ? "bt2020nc" : (MATRIX[code] ?? "bt709");
    fullRange = kind === "nclx" && c.end - c.start >= 11 ? (bytes[c.start + 10] & 0x80) !== 0 : false;
    break;
  }
  const bitDepth = bitDepthOf(bytes, entry, format);
  const named = (id: string) => contains(bytes, id) || facts.metadata.some((m) => contains(m, id));
  let detected: SourceProfile;
  if (named(APPLE_LOG_2)) detected = "apple-log-2";
  else if (named(APPLE_LOG) || named(APPLE_CUSTOM_GAMMA)) detected = "apple-log";
  else if (transfer === 18 && hdrMatrix) detected = "hlg";
  else if (transfer === 16 && hdrMatrix) detected = "pq";
  else if (transfer === 13) detected = "srgb";
  else detected = "rec709";
  return { code: { matrix, fullRange, bitDepth }, detected, codec: format };
}

/** An asset's color record from a probe: the code format and the profile
 * the header settles on. */
export type ProbedColor = CodeFormat & { detected: SourceProfile; codec: string };

export const colorRecord = (probe: ColorProbe): ProbedColor => ({
  ...probe.code,
  detected: probe.detected,
  codec: probe.codec,
});

/** The video assets that carry no color record yet. */
export const lacksColor = <A extends { type: string; color?: unknown; block?: unknown }>(a: A): boolean =>
  a.type === "video" && !a.color && !a.block;

/**
 * Color records for every video asset the timeline draws that has none, one
 * header walk per file, keyed by file name. `used` names the assets the
 * frame reads (`pictureAssetIds`): a file sitting unused in the Media panel is
 * never walked, and a used file whose header cannot be read fails the call,
 * naming it. Each process hands in its own way to reach the bytes — a URL in
 * the tab and the runner, the file on disk in the engine — and every caller
 * fills its assets from the one answer.
 */
export async function probeMissingColors<A extends { id: string; type: string; fileName: string; color?: unknown; block?: unknown }>(
  assets: readonly A[],
  used: ReadonlySet<string>,
  probe: (asset: A) => Promise<ColorProbe>
): Promise<Map<string, ProbedColor>> {
  const found = new Map<string, ProbedColor>();
  const walks = new Map<string, A>();
  for (const a of assets) if (used.has(a.id) && lacksColor(a) && !walks.has(a.fileName)) walks.set(a.fileName, a);
  await Promise.all(
    [...walks].map(async ([fileName, asset]) => {
      try {
        found.set(fileName, colorRecord(await probe(asset)));
      } catch (e) {
        throw new Error(`The color of ${fileName} could not be read: ${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );
  return found;
}

/** `assets` with the colors `probeMissingColors` found filled in. */
export const withFoundColors = <A extends { type: string; fileName: string; color?: unknown; block?: unknown }>(
  assets: A[],
  found: ReadonlyMap<string, ProbedColor>
): A[] =>
  found.size === 0
    ? assets
    : assets.map((a) => (lacksColor(a) && found.has(a.fileName) ? { ...a, color: found.get(a.fileName) } : a));

/** `readRange` over bytes already in hand. */
export const rangeOfBytes =
  (bytes: Uint8Array): ReadRange =>
  async (offset, length) =>
    bytes.subarray(offset, Math.min(bytes.length, offset + length));

/** `readRange` over a Blob or File. */
export const rangeOfBlob =
  (blob: Blob): ReadRange =>
  async (offset, length) =>
    new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + length)).arrayBuffer());
