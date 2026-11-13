// How long the render worker's jobs may run, shared by the poller (main.ts),
// which enforces them, and the container shell (cf/worker.ts), which must
// keep a replica up for as long as a job in it may run.
import { WORKER_BATCH } from "../server/cloud/batchKinds";

/** The longest a job of each kind may run. Everything else about a job's cost
 * is bounded when it is queued; this bounds the one thing that isn't — a
 * render that keeps ffmpeg talking forever holds a billed container. */
export const MAX_RUNTIME_MS: Record<string, number> = {
  export: 60 * 60_000,
  preview: 20 * 60_000,
  card: 10 * 60_000,
  hls: 3 * 60 * 60_000,
  import_url: 20 * 60_000,
  convert: 60 * 60_000,
  proxy: 60 * 60_000,
  agent_turn: 20 * 60_000,
  [WORKER_BATCH]: 10 * 60_000,
};
export const DEFAULT_MAX_RUNTIME_MS = 60 * 60_000;

// Cloudflare sends SIGTERM 15 minutes before SIGKILL and rolls replicas one at
// a time, so a deploy can let a render finish rather than throw it away. Drain
// inside that window, keeping enough of it back to requeue whatever is still
// going when it closes.
export const DRAIN_MS = 13 * 60_000;

/** The longest a replica may go without a wake and still be doing its job:
 * the longest job and the drain behind it. Only a wake renews the container's
 * idle timer, and a running job gets none, so a timer shorter than this stops
 * a render partway and requeues it to wait for some later wake. */
export const LONGEST_RUN_MS = Math.max(DEFAULT_MAX_RUNTIME_MS, ...Object.values(MAX_RUNTIME_MS)) + DRAIN_MS;
