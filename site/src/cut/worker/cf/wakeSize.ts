// How many replicas a wake starts. Kept apart from worker.ts so it can be
// tested outside the Workers runtime.

// The pool's size; the same number as REPLICAS in worker.ts and max_instances
// in ../wrangler.jsonc.
export const MAX_REPLICAS = 4;

// What the hosted API knows about the queue when it wakes the pool
// (server/cloud/wake.ts). A wake with no body still starts one replica: the
// caller has work, it just did not say how much.
export type WakeBody = { queued?: unknown; running?: unknown };

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

/** How many replicas a wake starts. Queued jobs each need an idle replica;
 * running jobs each hold one, and which one is unknown, so the count reaches
 * past them: of the lowest `queued + running` replicas at most `running` are
 * busy, which leaves at least `queued` idle ones to claim the work. */
export function replicasToStart(body: WakeBody | null): number {
  const needed = count(body?.queued) + count(body?.running);
  return Math.min(MAX_REPLICAS, Math.max(1, needed));
}
