/**
 * Folding decoded audio into an answer, a chunk at a time.
 *
 * Audio arrives from the reader in whatever spans the decoder hands back, so
 * anything measured over a window — silence, in practice — has to carry its
 * running state across chunk seams. Keeping that fold here, over plain sample
 * arrays, is what lets it be tested without a decoder.
 */

/** Decoded PCM for one span: one array per channel, all the same length. */
export interface PcmChunk {
  channels: Float32Array[];
  /** Where this span starts, in source seconds. */
  timestamp: number;
  sampleRate: number;
}

export interface SilenceSpan {
  start: number;
  end: number;
  duration: number;
}

export interface SilenceOptions {
  /** Absolute source seconds the scan covers; `to` open-ended when omitted. */
  from: number;
  to?: number;
  /** Level below which a window counts as silent, in dBFS. */
  thresholdDb: number;
  /** Shorter runs of silence are not reported. */
  minSilence: number;
}

/** The measurement window, in seconds — what ffmpeg's silencedetect uses. */
const WINDOW = 0.02;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Silent spans in `chunks`, by RMS over 20ms windows.
 *
 * A window is silent when its RMS across every channel falls under the
 * threshold; consecutive silent windows merge, and a run shorter than
 * `minSilence` is dropped. Windows are measured against the timeline the
 * chunks carry, so a decoder that hands back spans of uneven length — or one
 * that starts a span mid-window — reports the same silences as one that
 * doesn't.
 */
export async function scanSilence(
  chunks: AsyncIterable<PcmChunk>,
  opts: SilenceOptions
): Promise<SilenceSpan[]> {
  const { from, to, minSilence } = opts;
  const threshold = Math.pow(10, opts.thresholdDb / 20);
  const silences: SilenceSpan[] = [];

  // Windows sit on a fixed grid anchored at `from` rather than starting
  // wherever the previous one ended. That is what makes the answer independent
  // of how the decoder happened to split the audio: a boundary is a property of
  // the timeline, so a chunk that starts mid-window is measured into the window
  // it belongs to instead of starting a new one.
  const windowAt = (index: number) => from + index * WINDOW;

  let open: number | null = null;
  let index = -1;
  let end = from;
  let sum = 0;
  let count = 0;

  /** End an open silent run at `endT`, keeping it if it ran long enough. */
  const close = (endT: number) => {
    if (open !== null && endT - open >= minSilence) {
      const start = round2(Math.max(from, open));
      const stop = round2(endT);
      if (stop > start) silences.push({ start, end: stop, duration: round2(stop - start) });
    }
    open = null;
  };

  /** Judge the window that just filled and clear the accumulator. */
  const settle = () => {
    if (index >= 0 && count > 0) {
      if (Math.sqrt(sum / count) < threshold) {
        open ??= windowAt(index);
      } else {
        close(windowAt(index));
      }
    }
    sum = 0;
    count = 0;
  };

  for await (const { channels, timestamp, sampleRate } of chunks) {
    if (channels.length === 0) continue;
    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      const at = timestamp + i / sampleRate;
      if (at < from) continue;
      if (to !== undefined && at >= to) break;
      const window = Math.floor((at - from) / WINDOW);
      if (window !== index) {
        settle();
        index = window;
      }
      for (const ch of channels) sum += ch[i] * ch[i];
      count += channels.length;
      end = at + 1 / sampleRate;
    }
  }

  settle();
  close(to !== undefined ? Math.min(to, end) : end);
  return silences;
}
