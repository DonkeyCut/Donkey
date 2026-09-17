import type { PostFn } from "./pi/donkeyStream";
import type { Entry, JudgeQuestion, JudgeResult } from "@/lib/inference/judge";

export { choice, noul, score } from "@/lib/inference/judge";
export type { ChoiceAnswer, Entry, JudgeQuestion, JudgeResult, NoulAnswer, ScoreAnswer } from "@/lib/inference/judge";

// The page's and the worker's side of a judgment: post the state and the
// questions to the judge route through the bound transport (session and
// credits ride on it) and hand back the typed answers. Callers compose the
// probabilities under their own thresholds; a failed call throws, and each
// caller decides what its safe verdict is.

export class JudgeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "JudgeError";
  }
}

export async function askJudge<Q extends Record<string, JudgeQuestion>>(
  post: PostFn,
  state: Entry,
  questions: Q,
  signal?: AbortSignal,
): Promise<JudgeResult<Q>> {
  const res = await post({ state, questions }, signal);
  if (!res.ok) {
    let message = `judge ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {}
    throw new JudgeError(message, res.status);
  }
  return (await res.json()) as JudgeResult<Q>;
}

/** Split a per-item question map into requests of at most `size` questions,
 * ask them in parallel, and merge the answers back under their keys. */
export async function askJudgeChunked<Q extends Record<string, JudgeQuestion>>(
  post: PostFn,
  state: (keys: (keyof Q & string)[]) => Entry,
  questions: Q,
  size: number,
  signal?: AbortSignal,
): Promise<JudgeResult<Q>["answers"]> {
  const keys = Object.keys(questions) as (keyof Q & string)[];
  const chunks: (keyof Q & string)[][] = [];
  for (let i = 0; i < keys.length; i += size) chunks.push(keys.slice(i, i + size));
  const results = await Promise.all(
    chunks.map((chunk) => {
      const subset = Object.fromEntries(chunk.map((k) => [k, questions[k]])) as unknown as Q;
      return askJudge(post, state(chunk), subset, signal);
    }),
  );
  return Object.assign({}, ...results.map((r) => r.answers)) as JudgeResult<Q>["answers"];
}
