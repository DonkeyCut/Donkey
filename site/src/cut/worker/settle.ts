import { isTabExport } from "../lib/exportDelivery";

/** The exit code ffmpeg gives when it traps a termination signal and stops
 * ("Exiting normally, received signal 15"). */
const FFMPEG_SIGNAL_EXIT = 255;

/** How the job's last child process ended, as a ChildProcess reports it. */
type ProcExit = { signalCode: string | null; exitCode: number | null };

/**
 * What becomes of a job whose run threw. A canceled job's row already says so
 * and is left alone. Once the worker has been sent SIGTERM, the platform's
 * signal reaches the job's ffmpeg as well, which stops mid-encode: a run whose
 * process ended that way goes back on the queue for the next replica. Any
 * other failure, during the drain or not, is the job's own error.
 */
export function failedJobFate(run: { canceled: boolean; signaled: boolean; proc?: ProcExit }): "leave" | "requeue" | "error" {
  if (run.canceled) {
    return "leave";
  }
  return run.signaled && run.proc && stoppedBySignal(run.proc) ? "requeue" : "error";
}

function stoppedBySignal(proc: ProcExit): boolean {
  return proc.signalCode !== null || proc.exitCode === FFMPEG_SIGNAL_EXIT;
}

/** True when the job's process ran to its own end and refused its input: a
 * non-zero exit that no signal caused. */
export function refusedInput(proc: ProcExit | undefined): boolean {
  if (!proc || proc.exitCode === null || proc.exitCode === 0) {
    return false;
  }
  return !stoppedBySignal(proc);
}

/** A run that failed on its input, carrying the `fault` its row records in
 * `result` beside the message. */
export class InputFault extends Error {
  constructor(
    readonly fault: string,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** How long a tab render's claim may go without the tab's heartbeat before
 * the tab counts as closed. A hidden tab's timers can be held to one a
 * minute, so this is several of those. */
export const TAB_EXPORT_SILENCE_MS = 5 * 60_000;

/**
 * What the stale sweep does with a quiet "running" row. A worker's job lost
 * its worker and goes back on the queue. A tab render's claim never belonged
 * to a worker, which has nothing to draw it from, so it is never queued: once
 * its tab has been silent past TAB_EXPORT_SILENCE_MS the claim is dismissed,
 * which frees its slot.
 */
export function staleRunningFate(row: { spec: unknown; updatedAt: Date }, now: number): "requeue" | "dismiss" | "wait" {
  if (!isTabExport(row.spec)) {
    return "requeue";
  }
  return now - row.updatedAt.getTime() > TAB_EXPORT_SILENCE_MS ? "dismiss" : "wait";
}
