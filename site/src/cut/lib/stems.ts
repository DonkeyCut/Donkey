/**
 * Stems: the cut's audio split by where it lives on the timeline, one WAV per
 * part, packed in one zip beside the video.
 *
 * A stem is a lane of sound printed on its own over the whole delivery: every
 * file starts at the delivery's first sample and runs to its last, so they
 * line up when dropped side by side in a mixer. They are printed before the
 * master, with every volume, fade, duck and effect element the mix has, so
 * adding them back together gives the mix as it was before its loudness gain.
 *
 * Pure, so the tab, the engine and the worker all plan the same stems and
 * write the same files.
 */

import { assetIsSilent, type AudioClip, type MediaAsset, type VideoClip } from "./types";
import { wavHeader } from "./wav";

/** One stem: what it is called, the file it lands in, and what it carries —
 * the sound of every video clip (`lane` null), or one soundtrack lane. */
export interface StemDef {
  name: string;
  file: string;
  lane: number | null;
}

type StemDoc = {
  clips: Pick<VideoClip, "assetId" | "muted" | "hidden">[];
  audioClips: Pick<AudioClip, "assetId" | "hidden" | "lane" | "duck" | "name">[];
  assets: Pick<MediaAsset, "id" | "type" | "name" | "origin" | "beats">[];
};

/** A name as a file name takes it. */
const fileSafe = (name: string) => name.replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 40);

/** A media file's name without its extension. */
const bare = (name: string) => name.replace(/\.[a-z0-9]{2,4}$/i, "");

/**
 * What a soundtrack lane holds, as a name: the voiceover, the music, the one
 * file it plays, or its number when it mixes several things.
 */
function laneName(lane: number, clips: StemDoc["audioClips"], assets: Map<string, StemDoc["assets"][number]>): string {
  const sources = clips.map((c) => assets.get(c.assetId)!);
  if (sources.every((a, i) => a.origin === "voiceover" || (clips[i].duck ?? 1) < 1)) return "Voiceover";
  if (sources.every((a) => (a.beats?.bpm ?? 0) > 0)) return "Music";
  const ids = new Set(clips.map((c) => c.assetId));
  if (ids.size === 1) {
    const named = fileSafe(clips[0].name?.trim() || bare(sources[0].name));
    if (named) return named;
  }
  return `Audio ${lane + 1}`;
}

/**
 * The stems a cut splits into: the video clips' own sound first, when any of
 * it plays, then each soundtrack lane that has something on it, in lane
 * order. Muted and hidden clips, and lanes of nothing audible, make no stem.
 */
export function planStems(doc: StemDoc): StemDef[] {
  const assets = new Map(doc.assets.map((a) => [a.id, a]));
  const audible = (assetId: string) => {
    const a = assets.get(assetId);
    return !!a && !assetIsSilent(a);
  };
  const stems: Omit<StemDef, "file">[] = [];
  if (doc.clips.some((c) => !c.muted && !c.hidden && audible(c.assetId))) {
    stems.push({ name: "Dialogue", lane: null });
  }
  const lanes = new Map<number, StemDoc["audioClips"]>();
  for (const c of doc.audioClips) {
    if (c.hidden || !audible(c.assetId)) continue;
    const lane = c.lane ?? 0;
    lanes.set(lane, [...(lanes.get(lane) ?? []), c]);
  }
  for (const lane of [...lanes.keys()].sort((a, b) => a - b)) {
    stems.push({ name: laneName(lane, lanes.get(lane)!, assets), lane });
  }
  // Two lanes of music read "Music" and "Music 2".
  const seen = new Map<string, number>();
  return stems.map((s, i) => {
    const n = (seen.get(s.name) ?? 0) + 1;
    seen.set(s.name, n);
    const name = n === 1 ? s.name : `${s.name} ${n}`;
    return { ...s, name, file: `${i + 1} ${name}.wav` };
  });
}

/* ------------------------------------------------------- WAV */

/** Stems are 24-bit: headroom for a mix that peaks over full scale before
 * its master, and the width an audio editor works in. */
const STEM_BYTES_PER_SAMPLE = 3;

/** Every stem's rate and layout, whichever renderer prints it: 48 kHz
 * stereo, what an audio editor opens a session at. */
export const STEM_RATE = 48000;
export const STEM_CHANNELS = 2;

/** The size of a WAV file holding `frames` frames. */
export function wavBytes(frames: number, channels: number): number {
  return 44 + frames * channels * STEM_BYTES_PER_SAMPLE;
}

/** Planar float samples [from, to) as interleaved 24-bit PCM. Past ±1 is
 * clamped; a sample that is not there (a stem shorter than the delivery)
 * is silence. */
export function pcm24(channels: ArrayLike<number>[], from: number, to: number, count: number): Uint8Array {
  const frames = Math.max(0, to - from);
  const out = new Uint8Array(frames * count * STEM_BYTES_PER_SAMPLE);
  let o = 0;
  for (let i = from; i < to; i++) {
    for (let c = 0; c < count; c++) {
      const src = channels[c] ?? channels[0];
      const x = src && i < src.length ? src[i] : 0;
      const s = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388607)));
      out[o++] = s & 0xff;
      out[o++] = (s >> 8) & 0xff;
      out[o++] = (s >> 16) & 0xff;
    }
  }
  return out;
}

/* ------------------------------------------------------- zip */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of `data`, continuing from `crc` (0 to start). */
export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** A file in a stored (uncompressed) zip. PCM barely compresses, so every
 * entry is stored and the archive is written straight through, its size and
 * checksum known before its bytes go out. */
interface ZipEntry {
  name: string;
  size: number;
  crc: number;
}

const MAX32 = 0xffffffff;
const UTF8_NAMES = 0x0800;
/** 1980-01-01 00:00 in DOS time: the archive carries no clock. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

const writer = (size: number) => {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  let at = 0;
  return {
    b,
    u16: (n: number) => (v.setUint16(at, n, true), (at += 2)),
    u32: (n: number) => (v.setUint32(at, n >>> 0, true), (at += 4)),
    u64: (n: number) => (v.setBigUint64(at, BigInt(n), true), (at += 8)),
    bytes: (x: Uint8Array) => (b.set(x, at), (at += x.length)),
  };
};

/** The local header that goes before an entry's bytes. A file of 4 GB or
 * more carries its sizes in a Zip64 field. */
function zipLocalHeader(entry: ZipEntry): Uint8Array {
  const name = new TextEncoder().encode(entry.name);
  const big = entry.size >= MAX32;
  const w = writer(30 + name.length + (big ? 20 : 0));
  w.u32(0x04034b50);
  w.u16(big ? 45 : 20);
  w.u16(UTF8_NAMES);
  w.u16(0);
  w.u16(0);
  w.u16(DOS_DATE);
  w.u32(entry.crc);
  w.u32(big ? MAX32 : entry.size);
  w.u32(big ? MAX32 : entry.size);
  w.u16(name.length);
  w.u16(big ? 20 : 0);
  w.bytes(name);
  if (big) {
    w.u16(0x0001);
    w.u16(16);
    w.u64(entry.size);
    w.u64(entry.size);
  }
  return w.b;
}

/** The central directory and end records for entries whose local headers
 * start at `offsets`, the directory itself starting at `at`. Zip64 records
 * join when a size or an offset passes 4 GB. */
function zipDirectory(entries: ZipEntry[], offsets: number[], at: number): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  entries.forEach((e, i) => {
    const name = enc.encode(e.name);
    const bigSize = e.size >= MAX32;
    const bigOffset = offsets[i] >= MAX32;
    const extra = (bigSize ? 16 : 0) + (bigOffset ? 8 : 0);
    const w = writer(46 + name.length + (extra ? 4 + extra : 0));
    w.u32(0x02014b50);
    w.u16(45);
    w.u16(bigSize || bigOffset ? 45 : 20);
    w.u16(UTF8_NAMES);
    w.u16(0);
    w.u16(0);
    w.u16(DOS_DATE);
    w.u32(e.crc);
    w.u32(bigSize ? MAX32 : e.size);
    w.u32(bigSize ? MAX32 : e.size);
    w.u16(name.length);
    w.u16(extra ? 4 + extra : 0);
    w.u16(0);
    w.u16(0);
    w.u16(0);
    w.u32(0);
    w.u32(bigOffset ? MAX32 : offsets[i]);
    w.bytes(name);
    if (extra) {
      w.u16(0x0001);
      w.u16(extra);
      if (bigSize) {
        w.u64(e.size);
        w.u64(e.size);
      }
      if (bigOffset) w.u64(offsets[i]);
    }
    parts.push(w.b);
  });
  const dirSize = parts.reduce((s, p) => s + p.length, 0);
  const zip64 = at >= MAX32 || dirSize >= MAX32 || entries.length >= 0xffff || entries.some((e, i) => e.size >= MAX32 || offsets[i] >= MAX32);
  if (zip64) {
    const w = writer(56 + 20);
    const end64 = at + dirSize;
    w.u32(0x06064b50);
    w.u64(44);
    w.u16(45);
    w.u16(45);
    w.u32(0);
    w.u32(0);
    w.u64(entries.length);
    w.u64(entries.length);
    w.u64(dirSize);
    w.u64(at);
    w.u32(0x07064b50);
    w.u32(0);
    w.u64(end64);
    w.u32(1);
    parts.push(w.b);
  }
  const w = writer(22);
  w.u32(0x06054b50);
  w.u16(0);
  w.u16(0);
  w.u16(zip64 ? 0xffff : entries.length);
  w.u16(zip64 ? 0xffff : entries.length);
  w.u32(zip64 ? MAX32 : dirSize);
  w.u32(zip64 ? MAX32 : at);
  w.u16(0);
  parts.push(w.b);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Write a stored zip through `write`, entry by entry. Each entry is read
 * twice: once for its checksum, which the local header carries, and once for
 * its bytes — so nothing holds a whole file in memory.
 */
export async function writeStoredZip(
  entries: { name: string; size: number; read: () => AsyncIterable<Uint8Array> }[],
  write: (bytes: Uint8Array) => Promise<void> | void
): Promise<void> {
  let at = 0;
  const done: ZipEntry[] = [];
  const offsets: number[] = [];
  const put = async (b: Uint8Array) => {
    await write(b);
    at += b.length;
  };
  for (const e of entries) {
    let crc = 0;
    let size = 0;
    for await (const b of e.read()) {
      crc = crc32(b, crc);
      size += b.length;
    }
    if (size !== e.size) throw new Error(`${e.name} changed size while it was being packed.`);
    const entry = { name: e.name, size, crc };
    offsets.push(at);
    await put(zipLocalHeader(entry));
    for await (const b of e.read()) await put(b);
    done.push(entry);
  }
  await put(zipDirectory(done, offsets, at));
}

/** A planar stem as WAV bytes, a slice at a time: the header, then the
 * samples. `frames` is the delivery's length, whatever the stem holds. */
export async function* wavChunks(
  channels: ArrayLike<number>[],
  frames: number,
  count: number,
  sampleRate: number
): AsyncGenerator<Uint8Array> {
  yield wavHeader(frames, count, sampleRate, STEM_BYTES_PER_SAMPLE * 8);
  const slice = Math.max(1, sampleRate);
  for (let i = 0; i < frames; i += slice) {
    yield pcm24(channels, i, Math.min(frames, i + slice), count);
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}
