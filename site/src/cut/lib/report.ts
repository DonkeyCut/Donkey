"use client";

/**
 * Reporting a failure a feature carried on past.
 *
 * Cut's read paths — filmstrips, waveforms, the chunk cache, an import that
 * only lost one file — keep working when a read fails, and the failure still
 * has to be visible. `console.error` is that channel: PostHog's autocapture
 * turns one into an `$exception` (see instrumentation-client.ts). Handing it
 * the cause directly goes wrong twice.
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
  return (
    err instanceof TypeError &&
    /failed to fetch|network\s*error|load failed|connection/i.test(err.message)
  );
}

/**
 * Record a failure the feature already handled. `what` is the sentence that
 * ends up in error tracking, so it names the thing that failed and the file it
 * failed on.
 */
export function reportSwallowed(what: string, err: unknown): void {
  if (transient(err)) {
    console.warn(what, err);
    return;
  }
  console.error(new Error(what, { cause: err }));
}
