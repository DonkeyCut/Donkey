/**
 * The assistant's price check — what each hosted generation costs and what
 * the account holds — kept beside the Generate buttons that show the same
 * prices. The catalog spreads this list into the model's toolset and
 * `aiTools.ts` keys its handler on `CreditToolName`.
 */

import { obj, type AiToolDef } from "@/cut/lib/aiToolDef";
import { creditCountLabel, creditsPerDollar } from "@/lib/credits/format-credits";

export const CREDIT_TOOLS = [
  {
    name: "credit_prices",
    description: `What each hosted generation costs right now, in credits (${creditCountLabel(creditsPerDollar)} = $1): a video by resolution and length in seconds ("auto" is the model's own length), one image, a music track by length, and a minute of voiceover; plus the account's credit balance. Call it before quoting a price or when the user asks what something costs or how much they have left. Chat and edits bill by use and have no set price. Needs the user signed in to Donkey.`,
    inputSchema: obj({}),
  },
] as const satisfies readonly AiToolDef[];

export type CreditToolName = (typeof CREDIT_TOOLS)[number]["name"];
