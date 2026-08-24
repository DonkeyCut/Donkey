// What a subject or body may name, and where each value comes from. Saved
// templates and hand-typed notes go through the same fill, so a placeholder
// means the same thing either way.

/** The values a placeholder resolves to, for one recipient. */
export type OutreachVars = {
  /** First word of the account name. */
  firstName: string;
  /** The account name as Google gave it. */
  name: string;
  email: string;
  /** USD spent on model work so far, as a plain number string. */
  spent: string;
  /** USD left on the account. */
  balance: string;
};

export const OUTREACH_PLACEHOLDERS = [
  "firstName",
  "name",
  "email",
  "spent",
  "balance",
] as const satisfies readonly (keyof OutreachVars)[];

const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

export class UnknownPlaceholderError extends Error {
  public constructor(public readonly placeholder: string) {
    super(`Unknown placeholder {{${placeholder}}}.`);
    this.name = "UnknownPlaceholderError";
  }
}

/** Fills a subject or body for one recipient. An unknown placeholder throws
 * rather than mailing the braces out, so a typo is caught before the send. */
export function fillOutreachText(text: string, vars: OutreachVars): string {
  return text.replace(PLACEHOLDER, (_match, key: string) => {
    if (!(OUTREACH_PLACEHOLDERS as readonly string[]).includes(key)) {
      throw new UnknownPlaceholderError(key);
    }
    return vars[key as keyof OutreachVars];
  });
}
