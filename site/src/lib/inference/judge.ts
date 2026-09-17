import { z } from "zod";

// The judgment contract shared by the judge route, the page, and the worker:
// one state, named typed questions, one typed answer per question. The shapes
// mirror TypeSafe's System One API (noul = P(yes), choice = a distribution over
// named options, score = a distribution over ordered levels), so a caller reads
// probabilities and code decides. Zod only, so it is importable anywhere.

export type Entry = string | number | boolean | null | Entry[] | { [key: string]: Entry };

const entrySchema: z.ZodType<Entry> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(entrySchema), z.record(z.string(), entrySchema)]),
);

const noulQuestionSchema = z
  .object({
    type: z.literal("noul"),
    instructions: entrySchema.optional(),
    criteria: z.object({ true: entrySchema.optional(), false: entrySchema.optional() }).nullable().optional(),
  })
  .strict();

const choiceQuestionSchema = z
  .object({
    type: z.literal("choice"),
    instructions: entrySchema.optional(),
    criteria: z.record(z.string().min(1).max(200), entrySchema).refine((c) => Object.keys(c).length >= 2, {
      message: "A choice needs at least two options.",
    }),
  })
  .strict();

const scoreQuestionSchema = z
  .object({
    type: z.literal("score"),
    instructions: entrySchema.optional(),
    criteria: z.array(entrySchema).min(2).max(32),
  })
  .strict();

export const judgeQuestionSchema = z.discriminatedUnion("type", [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);

/** The most questions one request carries. Per-item sweeps (stock candidates,
 * transcript words) chunk under this. */
export const JUDGE_MAX_QUESTIONS = 200;

export const judgeRequestSchema = z
  .object({
    state: entrySchema,
    questions: z
      .record(z.string().min(1).max(120), judgeQuestionSchema)
      .refine((q) => Object.keys(q).length >= 1, { message: "At least one question." })
      .refine((q) => Object.keys(q).length <= JUDGE_MAX_QUESTIONS, {
        message: `At most ${JUDGE_MAX_QUESTIONS} questions per request.`,
      }),
  })
  .strict();

export type JudgeRequest = z.infer<typeof judgeRequestSchema>;

export interface NoulQuestion {
  type: "noul";
  instructions?: Entry;
  criteria?: { true?: Entry; false?: Entry } | null;
}
export interface ChoiceQuestion<C extends Record<string, Entry> = Record<string, Entry>> {
  type: "choice";
  instructions?: Entry;
  criteria: C;
}
export interface ScoreQuestion {
  type: "score";
  instructions?: Entry;
  criteria: readonly [Entry, Entry, ...Entry[]];
}
export type JudgeQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  /** P(yes), 0..1. */
  noul: number;
}
export interface ChoiceAnswer<C extends Record<string, Entry> = Record<string, Entry>> {
  type: "choice";
  choice: keyof C & string;
  probabilities: { [K in keyof C]: number };
  /** Concentration of the distribution, 0..1. */
  confidence: number;
}
export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted level, may fall between levels. */
  score: number;
  probabilities: Record<string, number>;
  legend: Record<string, Entry>;
  confidence: number;
}
export type JudgeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type AnswerFor<Q> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer C>
    ? ChoiceAnswer<C>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

export interface JudgeUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JudgeResult<Q extends Record<string, JudgeQuestion>> {
  model: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: JudgeUsage;
}

/** A yes/no question. */
export function noul(instructions: Entry, criteria?: { true?: Entry; false?: Entry }): NoulQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

/** One option out of a named set. */
export function choice<const C extends Record<string, Entry>>(instructions: Entry, criteria: C): ChoiceQuestion<C> {
  return { type: "choice", instructions, criteria };
}

/** A position along ordered levels. */
export function score(instructions: Entry, criteria: readonly [Entry, Entry, ...Entry[]]): ScoreQuestion {
  return { type: "score", instructions, criteria };
}
