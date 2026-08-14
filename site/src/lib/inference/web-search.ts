import { GoogleGenAI } from "@google/genai";

import { geminiClientConfig } from "@/lib/inference/adapters/gemini-client";
import { geminiModelRoles } from "@/lib/inference/gemini-models";

export type WebSearchSource = {
  title: string;
  url: string;
};

export type WebSearchResult = {
  /** A short grounded answer to the query (from the model). */
  summary: string;
  /** The web sources the answer is grounded in. */
  sources: WebSearchSource[];
};

/**
 * Web search via Gemini's built-in Google Search grounding on Vertex AI. This uses the backend's
 * service-account credential (the same one behind live-token) — no API key and no separate
 * Programmable Search Engine. The model searches the web for the query and returns a
 * grounded summary plus the source pages it used, which the caller turns into ranked results.
 */
export async function searchWeb(query: string): Promise<WebSearchResult | null> {
  const config = geminiClientConfig(process.env);
  if (!config.configured) {
    return null;
  }
  const client = new GoogleGenAI(config.options);

  const response = await client.models.generateContent({
    model: geminiModelRoles.chat,
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              `Search the web for: ${query}\n` +
              "Answer in one or two sentences from current results. The caller will read the source " +
              "pages itself, so keep it short.",
          },
        ],
      },
    ],
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0,
      // Cap synthesis: we mainly want the grounded sources, not a long essay. Less generation = less
      // latency on the grounded call (the Google search itself is the unavoidable part).
      maxOutputTokens: 400,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const candidate = response.candidates?.[0];
  const summary = (response.text ?? "").trim();
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const web = chunk.web;
    if (!web?.uri || seen.has(web.uri)) {
      continue;
    }
    seen.add(web.uri);
    sources.push({ title: web.title ?? web.uri, url: web.uri });
  }

  if (!summary && sources.length === 0) {
    return null;
  }
  return { summary, sources };
}
