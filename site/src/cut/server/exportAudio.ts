import { open } from "node:fs/promises";
import { masterStream, type MasterReport } from "../lib/loudness";
import { writeStoredZip } from "../lib/stems";

// The two pieces of an ffmpeg export's sound that ffmpeg does not do: the
// master, which runs the tab's own loudness code over the rendered mix so the
// two renderers land the same file at the same level, and the stems zip.
// Both stream through files a second at a time, so an hour of sound costs a
// second of it in memory.

/** Raw interleaved 32-bit float PCM in files laid end to end, read a second
 * at a time as planar chunks. */
async function* rawChunks(files: string[], sampleRate: number, channels: number): AsyncGenerator<Float32Array[]> {
  const frameBytes = channels * 4;
  const bytes = new Uint8Array(sampleRate * frameBytes);
  let carry = 0;
  for (const file of files) {
    const handle = await open(file, "r");
    try {
      let pos = 0;
      for (;;) {
        const { bytesRead } = await handle.read(bytes, carry, bytes.length - carry, pos);
        if (bytesRead === 0) {
          break;
        }
        pos += bytesRead;
        const have = carry + bytesRead;
        const frames = Math.floor(have / frameBytes);
        if (frames > 0) {
          const view = new DataView(bytes.buffer, 0, frames * frameBytes);
          const planar = Array.from({ length: channels }, () => new Float32Array(frames));
          for (let i = 0; i < frames; i++) {
            for (let c = 0; c < channels; c++) planar[c][i] = view.getFloat32((i * channels + c) * 4, true);
          }
          yield planar;
        }
        carry = have - frames * frameBytes;
        if (carry > 0) bytes.copyWithin(0, frames * frameBytes, have);
      }
    } finally {
      await handle.close();
    }
  }
}

/** Master the raw float mix in `inputs`, read in order as one stream, into
 * `output`, same layout. */
export async function masterRawMix(
  inputs: string[],
  output: string,
  opts: { sampleRate: number; channels: number; targetLufs: number; ceilingDbtp: number }
): Promise<MasterReport> {
  const out = await open(output, "w");
  try {
    return await masterStream(
      () => rawChunks(inputs, opts.sampleRate, opts.channels),
      async (chunk) => {
        const frames = chunk[0].length;
        const buf = new Uint8Array(frames * opts.channels * 4);
        const view = new DataView(buf.buffer);
        for (let i = 0; i < frames; i++) {
          for (let c = 0; c < opts.channels; c++) view.setFloat32((i * opts.channels + c) * 4, chunk[c][i], true);
        }
        await out.write(buf);
      },
      opts
    );
  } finally {
    await out.close();
  }
}

/** A file's bytes in slices. */
async function* fileChunks(file: string): AsyncGenerator<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const buf = new Uint8Array(1 << 20);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) return;
      pos += bytesRead;
      yield buf.slice(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

/** Pack rendered stem WAVs into one stored zip at `output`, each under its
 * own name. */
export async function packStems(files: { path: string; name: string }[], output: string): Promise<void> {
  const out = await open(output, "w");
  try {
    const entries = await Promise.all(
      files.map(async (f) => {
        const handle = await open(f.path, "r");
        const size = (await handle.stat()).size;
        await handle.close();
        return { name: f.name, size, read: () => fileChunks(f.path) };
      })
    );
    await writeStoredZip(entries, async (b) => {
      await out.write(b);
    });
  } finally {
    await out.close();
  }
}
