/**
 * A tiny in-memory job registry shared by the export and transcription
 * subsystems. It survives dev-server module reloads (the map hangs off
 * globalThis under `globalKey`) and keeps the map bounded: settled jobs are
 * dropped after a grace period so status polling still resolves, and the
 * terminal backlog is capped.
 */
export interface JobRegistry<J> {
  jobs: Map<string, J>;
  /** How many jobs are still running (for concurrency caps). */
  runningCount(): number;
  /** Schedule a settled job's eviction and trim the terminal backlog. */
  retire(job: J): void;
}

export function createJobRegistry<J extends { id: string; status: string }>(
  globalKey: string,
  opts: { maxJobs?: number; retireMs?: number; isTerminal?: (job: J) => boolean; onEvict?: (job: J) => void } = {}
): JobRegistry<J> {
  const maxJobs = opts.maxJobs ?? 50;
  const retireMs = opts.retireMs ?? 10 * 60 * 1000;
  // What counts as backlog to evict. Default: anything not running. A registry
  // with a queue passes its own predicate so waiting ("queued") jobs are never
  // mistaken for settled backlog and dropped before they get a slot.
  const isTerminal = opts.isTerminal ?? ((j: J) => j.status !== "running");
  const g = globalThis as unknown as Record<string, Map<string, J> | undefined>;
  const jobs = (g[globalKey] ??= new Map<string, J>());
  const retiring = new Set<string>();

  const runningCount = () => {
    let n = 0;
    for (const j of jobs.values()) if (j.status === "running") n++;
    return n;
  };

  const retire = (job: J) => {
    if (retiring.has(job.id)) return;
    retiring.add(job.id);
    setTimeout(() => {
      if (jobs.delete(job.id)) opts.onEvict?.(job);
      retiring.delete(job.id);
    }, retireMs).unref();
    const terminal = [...jobs.values()].filter(isTerminal);
    for (let i = 0; i < terminal.length - maxJobs; i++) {
      if (jobs.delete(terminal[i].id)) opts.onEvict?.(terminal[i]);
      retiring.delete(terminal[i].id);
    }
  };

  return { jobs, runningCount, retire };
}
