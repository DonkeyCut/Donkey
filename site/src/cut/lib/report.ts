"use client";

import { fetchDropped } from "./network";

/**
 * Reporting a failure a feature carried on past.
 *
 * Cut's read paths — filmstrips, waveforms, the chunk cache, an import that
 * only lost one file — keep working when a read fails, and the failure still
 * has to be visible. Error tracking is that channel (see instrumentation-client.ts),
 * and `console.error` reaches it too, through PostHog's autocapture. Handing
 * that the cause directly goes wrong twice.
 *
 * The sentence the call site wrote is dropped. Autocapture picks the `Error`
 * out of the arguments and reports that alone, so a filmstrip that failed on a
 * signed URL arrives in error tracking as a bare "TypeError: Failed to fetch"
 * with nothing saying what was being read.
 *
 * And weather arrives looking like a crash. A read fails because the network
 * blinked, the tab tore the read down, or the store evicted the bytes under
 * it — cases the retry beside the call site already covers, filed as unhandled
 * exceptions against the browser they happened in.
 *
 * So: the transient shapes go to `console.warn`, which autocapture leaves
 * alone, and everything else is reported as one `Error` that says what failed,
 * carrying the cause behind it.
 */

/**
 * Whether this failure is the kind every caller here already handles.
 *
 * Storage and teardown name themselves, so those are read off `name`. `fetch`
 * is the awkward one: every network-level failure — offline, DNS, a connection
 * cut mid-body, a local engine that went away between two range requests —
 * rejects with a bare `TypeError` whose wording is the only mark, and each
 * browser words it differently.
 */
function transient(err: unknown): boolean {
  // A read layer that names its own failures (mediaRead.ts wraps a refused
  // network read) carries the original underneath, and that is the shape which
  // decides.
  return shape(err) || (err instanceof Error && err.cause != null && shape(err.cause));
}

function shape(err: unknown): boolean {
  if (err instanceof DOMException) {
    return (
      // The read was torn down: a scrub superseded it, a clip closed, the tab
      // navigated.
      err.name === "AbortError" ||
      // The cached file was evicted between the handle and the read, or its
      // directory was swept. Reads fall back to the network.
      err.name === "NotFoundError" ||
      err.name === "NotReadableError" ||
      // The origin's store is full. Caching is optional everywhere it runs.
      err.name === "QuotaExceededError"
    );
  }
  return fetchDropped(err);
}

/** Where a report goes: the error and the key error tracking groups it by. */
type FailureSink = (error: Error, fingerprint: string) => void;

// Unbound — a headless process, a test — a report is a console error. The page
// binds error tracking here (instrumentation-client.ts).
let sink: FailureSink = (error) => console.error(error);

/** Send every report to `next` from here on. */
export function bindFailureSink(next: FailureSink): void {
  sink = next;
}

/**
 * The key one kind of failure is grouped under: the step that failed and the
 * chain of causes behind it, with the file it failed on left out. Error
 * tracking groups by message otherwise, so a filename in the sentence opened
 * one issue per file — "peaks failed for IMG_7087.MOV" and "… IMG_7091.MOV"
 * apart. Signed URLs are masked, since each carries its own signature.
 */
function fingerprintOf(what: string, err: unknown): string {
  const parts = [what];
  for (let at = err, depth = 0; at != null && depth < 4; depth++) {
    if (!(at instanceof Error)) {
      parts.push(String(at));
      break;
    }
    parts.push(`${at.name}: ${at.message.replace(/https?:\/\/\S+/g, "<url>")}`);
    at = at.cause;
  }
  return parts.join(" | ");
}

/**
 * Record a failure the feature already handled. `what` names the step that
 * failed, and `subject` the file or item it failed on: the message carries
 * both, and the grouping only the first.
 */
export function reportSwallowed(what: string, err: unknown, subject?: string): void {
  const message = subject ? `${what} for ${subject}` : what;
  if (transient(err)) {
    console.warn(message, err);
    return;
  }
  sink(new Error(message, { cause: err }), fingerprintOf(what, err));
}
