import type { FactCheckResponse } from "@/lib/inference/factCheck";
import { NO_CREDITS_MESSAGE } from "./credits";
import { hostedPost } from "./hosted";

// Checking a video's claims against the web, through the hosted fact-check
// route. The page, the cloud runner and the ChatGPT card all reach it with the
// user's session and credits.

export async function checkFacts(claims: string[], context?: string): Promise<FactCheckResponse> {
  const res = await hostedPost("/api/inference/fact-check", {
    claims,
    ...(context ? { context } : {}),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("Sign in to Donkey to check facts.");
    if (res.status === 402) throw new Error(NO_CREDITS_MESSAGE);
    const body = (await res.json().catch(() => null)) as {
      message?: unknown;
      error?: unknown;
      issues?: { path?: string; message?: string }[];
    } | null;
    const issue = body?.issues?.[0];
    const message = [body?.message, issue ? `${issue.path}: ${issue.message}` : undefined, body?.error].find(
      (v): v is string => typeof v === "string" && v.length > 0
    );
    throw new Error(message ?? `The fact check failed (${res.status}).`);
  }
  return (await res.json()) as FactCheckResponse;
}

/** The check_facts tool output: the verdicts for the model, and each claim's
 * Search Suggestions moved to `display`, where the chat shows them beside the
 * result and the model never reads them. */
export function factCheckToolOutput(results: FactCheckResponse["results"]) {
  const suggestions: string[] = [];
  const verdicts = results.map((r) => {
    if ("error" in r || !r.searchSuggestions) return r;
    const { searchSuggestions, ...rest } = r;
    if (!suggestions.includes(searchSuggestions)) suggestions.push(searchSuggestions);
    return rest;
  });
  const flagged = results.filter((r) => "error" in r || r.verdict !== "supported").length;
  return {
    results: verdicts,
    ...(flagged > 0
      ? { note: `${flagged} of ${results.length} claims are not supported as stated. Tell the user which, what the sources say, and where.` }
      : {}),
    ...(suggestions.length > 0 ? { display: { searchSuggestions: suggestions } } : {}),
  };
}
