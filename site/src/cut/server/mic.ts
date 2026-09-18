import { spawn, type ChildProcess } from "node:child_process";
import { assertLocalRuntime } from "./local-only";
import { createJobRegistry } from "./jobRegistry";
import { ensureStt } from "./transcribe";

// Live mic dictation for the AI chat composer. The browser captures the mic
// (it already holds that permission) and streams 16 kHz mono s16le PCM to the
// engine; this spawns `cut-stt --live`, forwards the PCM to its stdin, and
// exposes the evolving transcript. On-device only — nothing leaves the Mac.

export interface MicJob {
  id: string;
  status: "running" | "done" | "error" | "canceled";
  /** Latest transcript: the evolving partial while running, the final text once done. */
  text: string;
  error?: string;
  proc: ChildProcess;
  /** Resolves once the process has emitted its final text (or died). */
  finished: Promise<void>;
  /** Reaps an orphaned session: a live dictation feeds PCM every ~250ms, so a
   * gap this long means the client is gone (a tab refresh that never cancelled). */
  idle?: ReturnType<typeof setTimeout>;
  /** When PCM last arrived — the liveness signal that separates a live
   * dictation (recent audio) from a refresh orphan (silence). */
  lastFeedAt: number;
  /** Set when stopMic ends the input: the session is flushing its final text,
   * so silence is expected — the reclaimer must not read it as staleness. */
  finalizeAt?: number;
}

// A live dictation feeds continuously; no audio for this long means the tab that
// owned it went away without cancelling. The session self-reaps so a refresh
// never leaves a zombie cut-stt blocking the next dictation.
const IDLE_MS = 15000;
// A session with PCM more recent than this is live (a live client feeds every
// ~250ms) — a new start must never kill it mid-speech. Anything staler is an
// orphan a new start may reclaim without waiting out the idle reaper.
const STALE_MS = 1500;
// How long a confirmed session may take to flush its final text. cut-stt bounds
// its own finish well inside this, so passing it means the process is gone.
const STOP_MS = 8000;
// A confirmed session flushing its final text feeds no PCM by design; stopMic
// waits out STOP_MS for the flush, so only past that is the process fair game.
const FINALIZE_MS = STOP_MS + 1000;
const { jobs, retire } = createJobRegistry<MicJob>("__cutMicJobs");

function clearIdle(job: MicJob): void {
  if (job.idle) clearTimeout(job.idle);
  job.idle = undefined;
}

/** (Re)arm the orphan watchdog: if no PCM arrives within IDLE_MS the session is
 * abandoned, so kill it. */
function armIdle(job: MicJob): void {
  clearIdle(job);
  job.idle = setTimeout(() => {
    if (job.status === "running") {
      job.status = "canceled";
      job.proc.kill("SIGKILL");
    }
  }, IDLE_MS);
  job.idle.unref();
}

/** Reap running sessions whose audio went silent (a refresh that never reached
 * cancel), and report whether a genuinely live one remains. A live dictation —
 * PCM within STALE_MS — is someone speaking right now; killing it would
 * silently truncate their speech, so the caller rejects instead. */
function reclaimStale(): { liveRemains: boolean } {
  let liveRemains = false;
  for (const job of jobs.values()) {
    if (job.status !== "running") continue;
    if (job.finalizeAt) {
      // Confirmed and flushing its final text: silence is expected, not
      // staleness, and it doesn't block a new dictation from starting. Only a
      // flush hung past stopMic's own wait gets reaped.
      if (Date.now() - job.finalizeAt > FINALIZE_MS) {
        clearIdle(job);
        job.status = "canceled";
        job.proc.kill("SIGKILL");
      }
      continue;
    }
    if (Date.now() - job.lastFeedAt > STALE_MS) {
      clearIdle(job);
      job.status = "canceled";
      job.proc.kill("SIGKILL");
    } else {
      liveRemains = true;
    }
  }
  return { liveRemains };
}

export function getMicJob(id: string): MicJob | undefined {
  return jobs.get(id);
}

export async function startMicJob(locale: string): Promise<MicJob> {
  assertLocalRuntime();
  // One dictation at a time. A new start reclaims silent orphans (a refresh
  // that never reached cancel) so nobody is rejected forever, but a session
  // that is still receiving audio is someone speaking — reject instead of
  // killing their dictation mid-sentence.
  if (reclaimStale().liveRemains) {
    throw new Error("A dictation is already running — finish it first.");
  }
  const bin = await ensureStt();
  const id = crypto.randomUUID().slice(0, 12);
  const proc = spawn(bin, ["--live", locale], { stdio: ["pipe", "pipe", "pipe"] });

  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => (resolveFinished = r));
  const job: MicJob = { id, status: "running", text: "", proc, finished, lastFeedAt: Date.now() };
  jobs.set(id, job);
  armIdle(job);

  // Parse the process's NDJSON stdout line by line.
  let buf = "";
  proc.stdout?.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as { type: string; text?: string };
        if (ev.type === "partial") job.text = ev.text ?? job.text;
        else if (ev.type === "final") {
          job.text = ev.text ?? job.text;
          if (job.status === "running") job.status = "done";
        } else if (ev.type === "error") {
          job.error = ev.text || "Transcription failed.";
          if (job.status === "running") job.status = "error";
        }
      } catch {
        // Ignore a malformed line rather than tearing down a live dictation.
      }
    }
  });

  let stderr = "";
  proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  proc.on("error", (e) => {
    clearIdle(job);
    if (job.status === "running") {
      job.status = "error";
      job.error = e.message;
    }
    resolveFinished();
    retire(job);
  });
  proc.on("close", (code) => {
    clearIdle(job);
    if (job.status === "running") {
      // Closed without a final line — surface whatever the process complained about.
      job.status = code === 0 ? "done" : "error";
      if (job.status === "error") job.error = stderr.trim().split("\n").slice(-2).join("\n") || `cut-stt exited ${code}`;
    }
    resolveFinished();
    retire(job);
  });

  return job;
}

/** Forward a chunk of PCM to the running process. Returns false for an unknown/ended job. */
export function feedMic(id: string, pcm: Buffer): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== "running" || !job.proc.stdin?.writable) return false;
  job.proc.stdin.write(pcm);
  job.lastFeedAt = Date.now();
  armIdle(job); // fresh audio — the client is still here
  return true;
}

/** Close the input so the model flushes its final text, then wait for it. A
 * process that misses the deadline is not coming back, so it is killed here
 * rather than left holding the next dictation's slot. */
export async function stopMic(id: string): Promise<string | null> {
  const job = jobs.get(id);
  if (!job) return null;
  clearIdle(job);
  if (job.status === "running") {
    job.finalizeAt = Date.now();
    job.proc.stdin?.end();
  }
  if (!(await withTimeout(job.finished, STOP_MS))) job.proc.kill("SIGKILL");
  return job.text;
}

/** Discard a dictation in progress. */
export function cancelMic(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  clearIdle(job);
  if (job.status === "running") {
    job.status = "canceled";
    job.proc.kill("SIGKILL");
  }
  return true;
}

/** Resolves true when `p` settled in time, false when the deadline won. */
function withTimeout(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    t.unref();
    void p.finally(() => {
      clearTimeout(t);
      resolve(true);
    });
  });
}
