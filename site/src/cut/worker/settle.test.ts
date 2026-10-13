import { expect, test } from "bun:test";
import { failedJobFate, staleRunningFate, TAB_EXPORT_SILENCE_MS } from "./settle";

/** A deploy rolls the worker's replicas with SIGTERM, and the signal reaches
 * the job's ffmpeg too: it stops mid-encode and the run fails a minute in. A
 * proxy job died that way while the drain was meant to let it finish. A run
 * whose process the shutdown stopped goes back on the queue for the next
 * replica; any other failure during the drain is the job's own. */

const killed = { signalCode: "SIGTERM", exitCode: null };
/** ffmpeg traps SIGTERM and exits 255 ("received signal 15"). */
const trapped = { signalCode: null, exitCode: 255 };
const failed = { signalCode: null, exitCode: 1 };

test("a run whose process the shutdown stopped goes back on the queue", () => {
  expect(failedJobFate({ canceled: false, signaled: true, proc: killed })).toBe("requeue");
  expect(failedJobFate({ canceled: false, signaled: true, proc: trapped })).toBe("requeue");
});

test("a run that fails on its own during the drain is an error", () => {
  // A turn's model or tool error, a corrupt input: re-running repeats it,
  // and a turn would edit and charge twice.
  expect(failedJobFate({ canceled: false, signaled: true })).toBe("error");
  expect(failedJobFate({ canceled: false, signaled: true, proc: failed })).toBe("error");
  expect(failedJobFate({ canceled: false, signaled: false, proc: killed })).toBe("error");
});

test("a canceled run's row already says so", () => {
  expect(failedJobFate({ canceled: true, signaled: true, proc: killed })).toBe("leave");
  expect(failedJobFate({ canceled: true, signaled: false })).toBe("leave");
});

// A cloud project's export renders in the tab, which holds a "running" row as
// its claim. The sweep used to requeue that row a minute in, and a worker then
// failed it with "Malformed export spec." while the tab was still drawing.
test("a quiet worker job goes back on the queue", () => {
  const now = Date.now();
  expect(staleRunningFate({ spec: { fromDoc: {} }, updatedAt: new Date(now - 90_000) }, now)).toBe("requeue");
  expect(staleRunningFate({ spec: null, updatedAt: new Date(now - 90_000) }, now)).toBe("requeue");
});

test("a tab render's claim is never queued, and is let go once its tab is silent", () => {
  const now = Date.now();
  const claim = { client: true };
  expect(staleRunningFate({ spec: claim, updatedAt: new Date(now - 90_000) }, now)).toBe("wait");
  expect(staleRunningFate({ spec: { ...claim, stems: true }, updatedAt: new Date(now - TAB_EXPORT_SILENCE_MS - 1) }, now)).toBe("dismiss");
});
