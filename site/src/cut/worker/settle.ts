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
