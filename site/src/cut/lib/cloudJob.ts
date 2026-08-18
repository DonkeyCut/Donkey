"use client";

import { apiJson, type CutBackend } from "./backend";

/**
 * Wait on a cloud render job (URL import, conversion) and hand back its
 * result. The cloud answers those routes with a job id and a worker does the
 * work, so the client polls: 2s cadence, a ten-minute ceiling, and a run of
 * failed polls before giving up — a single dropped request keeps polling.
 * Failure reports what the job itself said, or `fallback`.
 */
export async function pollCloudJob<T>(
  jobId: string,
  backend: CutBackend,
  fallback: string,
  timedOut = fallback
): Promise<T> {
  const deadline = Date.now() + 10 * 60 * 1000;
  const MAX_STRIKES = 6;
  let strikes = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error(timedOut);
    await new Promise((r) => setTimeout(r, 2000));
    let res: Response | null = null;
    try {
      res = await backend.fetch(`/api/cut/jobs/${jobId}`);
    } catch {
      // Network blip — a strike, counted below.
    }
    // The create call returned this job's id, so a 404 means it's gone.
    if (res?.status === 404) throw new Error(fallback);
    if (!res?.ok) {
      if (++strikes >= MAX_STRIKES) throw new Error(fallback);
      continue;
    }
    strikes = 0;
    const job = await apiJson<{ state?: string; result?: T }>(res);
    if (job.state === "error") throw new Error(job.error ?? fallback);
    if (job.state === "done") return (job.result ?? {}) as T;
  }
}
