import type { FactCheckResponse } from "@/lib/inference/factCheck";
import { hostedPost } from "./hosted";
import { readHostedError } from "./hostedError";

// Checking a video's claims against the web, through the hosted fact-check
// route. The page, the cloud runner and the ChatGPT card all reach it with the
// user's session and credits.

/** The tool's input goes as given; the route holds it to the contract and
 * answers a bad claim with the field that broke it. */
export async function checkFacts(input: { claims?: unknown; context?: unknown }): Promise<FactCheckResponse> {
  const res = await hostedPost("/api/inference/fact-check", { claims: input.claims, context: input.context });
  if (!res.ok) {
    throw new Error(await readHostedError(res, "Sign in to Donkey to check facts.", `The fact check failed (${res.status}).`));
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
    suggestions.push(searchSuggestions);
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
