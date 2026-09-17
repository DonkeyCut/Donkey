/**
 * The render ladder's walk: one job tries fallback rungs in order until one
 * lands. Pure — the store (generate.ts) supplies the submission and polling;
 * this module owns only the policy of WHICH rung runs next, so the self-test
 * can prove it without a browser or a credit spent.
 */

import type { VideoGenOptions } from "./generate";

/** One rung of a render ladder: the prompt and options for a single hosted
 * submission. Job-level identity (chat ownership, genKey, placement) rides
 * the ladder call, not the rungs. */
export interface VideoAttempt {
  prompt: string;
  opts?: Omit<VideoGenOptions, "onDone" | "chatId" | "genKey">;
  /** Whether this rung runs, decided when the walk reaches it — `lastError` is
   * the previous rung's failure (null when nothing failed yet). Lets a caller
   * reserve a rung for specific failures, e.g. text-only only after the
   * provider refused the image anchor. Skipped rungs cost nothing and keep
   * the prior error. */
  gate?: (lastError: string | null) => boolean | Promise<boolean>;
}

/** Walk the rungs: run each in order, return on the first that lands. A rung
 * whose gate declines is skipped (costing nothing, keeping the prior error);
 * a `fatal` failure stops the walk outright — every later rung would fail the
 * same way. `onRungFailed` fires between a failed rung and the next. */
export async function walkLadder(
  attempts: VideoAttempt[],
  run: (attempt: VideoAttempt, rung: number) => Promise<void>,
  opts?: {
    onRungFailed?: (error: string, rung: number) => void;
    fatal?: (error: string) => boolean;
  }
): Promise<{ ok: boolean; error: string; rung?: number }> {
  let lastError = "Video generation failed.";
  let anyFailed = false;
  for (const [rung, attempt] of attempts.entries()) {
    if (attempt.gate && !(await attempt.gate(anyFailed ? lastError : null))) continue;
    try {
      await run(attempt, rung);
      return { ok: true, error: "", rung };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      anyFailed = true;
      if (opts?.fatal?.(lastError)) break;
      opts?.onRungFailed?.(lastError, rung);
    }
  }
  return { ok: false, error: lastError };
}
