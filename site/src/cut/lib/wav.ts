/** How a WAV's samples are coded: integer PCM or IEEE float. */
export type WavCoding = "pcm" | "float";

/** The WAV format tags RIFF names each coding by. */
const FORMAT_TAG: Record<WavCoding, number> = { pcm: 1, float: 3 };

/** The 44-byte RIFF header in front of `frames` interleaved frames. RIFF
 * counts in 32 bits, so data past 4 GB is refused. */
export function wavHeader(
  frames: number,
  channels: number,
  sampleRate: number,
  bits: number,
  coding: WavCoding = "pcm"
): Uint8Array<ArrayBuffer> {
  const bytes = bits / 8;
  const data = frames * channels * bytes;
  if (data + 36 > 0xffffffff) throw new Error("Audio this long does not fit in a WAV file.");
  const b = new Uint8Array(44);
  const v = new DataView(b.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((ch, i) => (b[at + i] = ch.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, FORMAT_TAG[coding], true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * bytes, true);
  v.setUint16(32, channels * bytes, true);
  v.setUint16(34, bits, true);
  ascii(36, "data");
  v.setUint32(40, data, true);
  return b;
}
