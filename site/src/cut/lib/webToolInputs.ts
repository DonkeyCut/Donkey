import {
  FACT_CLAIM_MAX_CHARS,
  FACT_CLAIMS_CEILING,
  FACT_CONTEXT_MAX_CHARS,
} from "@/lib/inference/factCheck";

// check_facts's claims, held to their shape before any request leaves. Pure,
// so the chat handler and its tests read the same rules.

type Checked<T> = ({ ok: true } & T) | { ok: false; error: string };

export function checkFactsInput(input: Record<string, unknown>): Checked<{ claims: string[]; context?: string }> {
  if (!Array.isArray(input.claims) || input.claims.length === 0)
    return { ok: false, error: "claims must list at least one statement to check." };
  const claims: string[] = [];
  for (const raw of input.claims) {
    if (typeof raw !== "string") return { ok: false, error: "Each claim must be a sentence of text." };
    const claim = raw.replace(/\s+/g, " ").trim();
    if (!claim) continue;
    if (claim.length > FACT_CLAIM_MAX_CHARS)
      return { ok: false, error: `Each claim must be one specific statement, under ${FACT_CLAIM_MAX_CHARS} characters.` };
    if (!claims.includes(claim)) claims.push(claim);
  }
  if (claims.length === 0) return { ok: false, error: "claims must list at least one statement to check." };
  if (claims.length > FACT_CLAIMS_CEILING)
    return { ok: false, error: `Check at most ${FACT_CLAIMS_CEILING} claims at a time.` };
  if (input.context !== undefined && typeof input.context !== "string")
    return { ok: false, error: "context must be text." };
  const context = typeof input.context === "string" ? input.context.trim().slice(0, FACT_CONTEXT_MAX_CHARS) : "";
  return { ok: true, claims, ...(context ? { context } : {}) };
}
