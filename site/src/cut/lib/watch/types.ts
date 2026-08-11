/** Frame selection for watch_video: both backends hand candidate frames to a
 * selector that keeps the distinct moments. The engine feeds it raw RGB frames
 * piped from ffmpeg; the browser feeds it ImageData. Pure data in, pure data
 * out — no DOM, no Node. */

/** Every candidate reaches the selector at this size; signatures divide it
 * evenly (192 = 12·16 = 6·32). */
export const SIGNATURE_SIZE = 192;

/** One candidate frame's pixels at SIGNATURE_SIZE × SIGNATURE_SIZE.
 * channels 3 = packed RGB (ffmpeg rawvideo), 4 = RGBA (canvas ImageData —
 * alpha is ignored). The selector copies what it needs; callers may reuse
 * the buffer. */
export interface RgbFrame {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Uint8Array | Uint8ClampedArray;
}

export type Verdict =
  | "first" // the opening frame — always kept
  | "keep-global" // whole-frame change vs the kept window
  | "keep-action" // hard local change on a small subject
  | "keep-settled" // a settled local change on a static scene (text, ink, UI)
  | "drop" // a near-duplicate of the kept window
  | "thinned"; // kept by the channels, removed by the max-frames cap

export interface FrameDecision {
  index: number;
  verdict: Verdict;
  /** Min % of 16-grid cells changed vs the kept window (the global channel). */
  globalDist: number;
  /** Max settled-mask cell %, when the settled channel ran. */
  settledScore?: number;
  /** The settled gate (cooldown included) that score was judged against. */
  settledGate?: number;
}

export interface SelectionResult {
  /** Kept candidate indices, ascending, after the max-frames cap. */
  kept: number[];
  decisions: FrameDecision[];
  candidateCount: number;
}

export interface SelectorOptions {
  /** Cap on kept frames; survivors are thinned evenly when the channels keep more. */
  maxFrames: number;
  /** Fires as each candidate's channel verdict lands (one frame behind push —
   * the settled channel looks ahead one frame). "thinned" is not known until
   * finish(); treat a keep here as provisional. */
  onDecision?: (d: FrameDecision) => void;
}

/** Push candidates in time order, then finish. Decisions stream one frame
 * behind push; finish flushes the last frame and applies the cap. */
export interface FrameSelector {
  push(frame: RgbFrame): void;
  finish(): SelectionResult;
}

export type SelectorFactory = (opts: SelectorOptions) => FrameSelector;
