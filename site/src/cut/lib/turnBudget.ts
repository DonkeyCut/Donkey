/** One turn's step budget, and how a turn ends. Shared by every provider.
 *
 * A step is one model round that asks for tools. Every provider stops
 * somewhere — this loop counts rounds, the Claude Agent SDK caps its own
 * turns — and a build that runs out mid-edit must not end on the provider's
 * word for it. The budget extends itself a few times so a long build
 * finishes on its own, and once it is spent the turn hands back in a
 * sentence the person can act on. A turn that ends saying nothing gets the
 * same treatment: tool chips with no words is not an ending.
 */

export const STEP_BUDGET = 24;
export const MAX_EXTENSIONS = 3;

/** Turn-local scaffolding: the prefix marks the steer so the save path can
 * keep it out of the stored session. */
export const BUDGET_STEER_PREFIX = "[budget]";

export const PAUSED_HANDOFF =
  'Paused at this turn\'s step limit with work still open. Say "keep going" to continue.';
export const SILENT_HANDOFF = 'That turn ended without a reply. Say "keep going" to pick it up.';

/** How a run ended: the model signed off, it spent its steps, it failed, or
 * it never got its tools. */
export type TurnEnd = "done" | "budget" | "failed" | "blocked";

export function budgetSteer(extension: number, maxExtensions: number = MAX_EXTENSIONS): string {
  return `${BUDGET_STEER_PREFIX} Step budget auto-extended (${extension} of ${maxExtensions}). Keep working; finish the job or report the concrete blocker.`;
}

/** What a finished run owes the person: more budget to carry on with, a line
 * to close on, or nothing when the model signed off itself. */
export function turnClose(opts: {
  end: TurnEnd;
  /** The run put words on screen. */
  spoke: boolean;
  /** Extensions already granted this turn. */
  extensions: number;
  maxExtensions?: number;
}): { steer: string } | { signoff: string } | null {
  const max = opts.maxExtensions ?? MAX_EXTENSIONS;
  if (opts.end === "budget")
    return opts.extensions < max
      ? { steer: budgetSteer(opts.extensions + 1, max) }
      : { signoff: PAUSED_HANDOFF };
  if (opts.end === "done" && !opts.spoke) return { signoff: SILENT_HANDOFF };
  return null;
}

/** A provider's own account of a stop, or a plain line when all it handed
 * back was a token or nothing at all. */
export function stopText(detail?: unknown): string {
  return typeof detail === "string" && detail.trim()
    ? detail.trim()
    : 'The turn stopped before it finished. Say "keep going" to pick it up.';
}
