"use client";

import { apiJson, type CutBackend } from "./backend";
import { errorFromBody, type UserError } from "./userError";

/**
 * Wait on a cloud render job (URL import, conversion) and hand back its
 * result. The cloud answers those routes with a job id and a worker does the
 * work, so the client polls: 2s cadence, a ten-minute ceiling, and a run of
 * failed polls before giving up — a single dropped request keeps polling.
 * Failure reports what the job itself said, with the code the worker recorded,
 * or `fallback`.
 *
 * `onState` sees every state the job reports ("queued", "running", …), so a
 * surface waiting on the job can say which one it is in; `onProgress` sees
 * the share done as the worker reports it.
 */
export async function pollCloudJob<T>(
  jobId: string,
  backend: CutBackend,
  fallback: UserError | string,
  {
    timedOut = fallback,
    onState,
    onProgress,
  }: { timedOut?: UserError | string; onState?: (state: string) => void; onProgress?: (progress: number) => void } = {}
): Promise<T> {
  const deadline = Date.now() + 10 * 60 * 1000;
  const MAX_STRIKES = 6;
  let strikes = 0;
  for (;;) {
    if (Date.now() > deadline) throw errorFromBody(null, timedOut);
    await new Promise((r) => setTimeout(r, 2000));
    let res: Response | null = null;
    try {
      res = await backend.fetch(`/api/cut/jobs/${jobId}`);
    } catch {
      // Network blip — a strike, counted below.
    }
    // The create call returned this job's id, so a 404 means it's gone.
    if (res?.status === 404) throw errorFromBody(null, fallback);
    if (!res?.ok) {
      if (++strikes >= MAX_STRIKES) throw errorFromBody(null, fallback);
      continue;
    }
    strikes = 0;
    const job = await apiJson<{ state?: string; progress?: number; result?: T }>(res);
    if (job.state) onState?.(job.state);
    if (typeof job.progress === "number") onProgress?.(job.progress);
    if (job.state === "error") throw errorFromBody(job, fallback);
    if (job.state === "done") return (job.result ?? {}) as T;
  }
}
