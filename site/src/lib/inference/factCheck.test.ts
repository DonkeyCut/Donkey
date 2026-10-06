import { describe, expect, test } from "bun:test";

import { createGeminiResponsesProvider, groundingFromCandidate } from "@/lib/inference/adapters/gemini-responses";
import { FACT_ANSWER_SCHEMA, factCheckRequestSchema, shapeFactCheck } from "@/lib/inference/factCheck";
import { isJsonObject } from "@/lib/inference/json";
import type { JsonObject } from "@/lib/inference/providers";
import { responseCreateRequestSchema } from "@/lib/inference/schemas";

// Google's Search Suggestions block, trimmed: CSS plus one chip per query.
const SUGGESTIONS_HTML =
  '<style>.container{display:flex}.chip{border-radius:16px}</style><div class="container"><div class="carousel">' +
  '<a class="chip" href="https://www.google.com/search?q=eiffel+tower+height&amp;client=app-vertex-grounding&amp;safesearch=active">eiffel tower height</a>' +
  '<a class="chip" href="https://www.google.com/search?q=eiffel+tower+antenna+2022&amp;client=app-vertex-grounding&amp;safesearch=active">eiffel tower antenna 2022</a>' +
  "</div></div>";

// A grounded generateContent answer as Vertex returns it: the verdict JSON in
// the text, the pages in groundingMetadata. The model's text names a URL of its
// own; only the grounding chunks may become sources.
const groundedResponse = {
  responseId: "r1",
  candidates: [
    {
      content: {
        role: "model",
        parts: [
          {
            text: JSON.stringify({
              verdict: "contradicted",
              corrected: "330 metres",
              note: "The tower stands 330 m since a 2022 antenna; see https://made-up.example/proof.",
            }),
          },
        ],
      },
      groundingMetadata: {
        webSearchQueries: ["eiffel tower height", "eiffel tower antenna 2022"],
        groundingChunks: [
          { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA", title: "toureiffel.paris" } },
          { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB", title: "wikipedia.org" } },
          { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA", title: "toureiffel.paris" } },
          { retrievedContext: { uri: "gs://not-web" } },
        ],
        groundingSupports: [{ segment: { startIndex: 0, endIndex: 10 }, groundingChunkIndices: [0, 1] }],
        searchEntryPoint: { renderedContent: SUGGESTIONS_HTML },
      },
    },
  ],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40, toolUsePromptTokenCount: 900, totalTokenCount: 1060 },
};

describe("grounding metadata", () => {
  test("sources come from the grounding chunks, deduplicated, web pages only", () => {
    const { sources, queries, searchSuggestions } = groundingFromCandidate(
      groundedResponse.candidates[0] as unknown as JsonObject,
    );
    expect(searchSuggestions).toBe(SUGGESTIONS_HTML);
    expect(sources).toEqual([
      { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA", title: "toureiffel.paris" },
      { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB", title: "wikipedia.org" },
    ]);
    expect(queries).toEqual(["eiffel tower height", "eiffel tower antenna 2022"]);
  });

  test("a candidate without grounding has no sources", () => {
    expect(groundingFromCandidate(undefined)).toEqual({ sources: [], queries: [] });
    expect(groundingFromCandidate({ content: {} })).toEqual({ sources: [], queries: [] });
  });
});

describe("the adapter's grounded call", () => {
  test("web_search turns on Google Search, and the response carries the sources", async () => {
    let sent: Record<string, unknown> | null = null;
    const provider = createGeminiResponsesProvider(
      {
        GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
          project_id: "p",
          client_email: "svc@p.iam.gserviceaccount.com",
          private_key: "key",
        }),
      },
      () =>
        ({
          models: {
            generateContent: async (params: Record<string, unknown>) => {
              sent = params;
              return groundedResponse;
            },
          },
          caches: {},
        }) as never,
    );
    const request = responseCreateRequestSchema.parse({
      donkeyProvider: "gemini",
      model: "gemini-test",
      instructions: "Check it.",
      input: "Claim: The Eiffel Tower is 300 m tall.",
      tools: [{ type: "web_search" }],
      text: { format: { type: "json_schema", name: "fact_check", schema: FACT_ANSWER_SCHEMA } },
    });
    expect(provider.canCreateResponse?.(request)).toBe(true);
    const result = await provider.createResponse!(request);
    const config = (sent as unknown as { config: Record<string, unknown> }).config;
    expect(config.tools).toEqual([{ googleSearch: {} }]);
    expect(config.responseMimeType).toBe("application/json");
    const body = result.body as JsonObject;
    expect(isJsonObject(body) && Array.isArray(body.sources) ? body.sources.length : 0).toBe(2);
    expect(body.search_queries).toEqual(["eiffel tower height", "eiffel tower antenna 2022"]);
    expect(body.search_suggestions).toBe(SUGGESTIONS_HTML);

    const shaped = shapeFactCheck(
      "The Eiffel Tower is 300 m tall.",
      String(body.output_text),
      body.sources as { url: string; title: string }[],
      { minSources: 2, maxSources: 5, searchSuggestions: String(body.search_suggestions) },
    );
    expect(shaped).toEqual({
      claim: "The Eiffel Tower is 300 m tall.",
      verdict: "contradicted",
      corrected: "330 metres",
      note: "The tower stands 330 m since a 2022 antenna; see https://made-up.example/proof.",
      sources: [
        { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA", title: "toureiffel.paris" },
        { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB", title: "wikipedia.org" },
      ],
      searchSuggestions: SUGGESTIONS_HTML,
    });
    expect(shaped.sources.some((s) => s.url.includes("made-up.example"))).toBe(false);
  });

  test("an ungrounded request keeps web_search out unless Gemini was named", () => {
    const provider = createGeminiResponsesProvider({}, () => ({}) as never);
    const request = responseCreateRequestSchema.parse({ input: "x", tools: [{ type: "web_search" }] });
    expect(provider.canCreateResponse?.(request)).toBe(false);
  });
});

describe("shapeFactCheck", () => {
  const two = [
    { url: "https://a.example/1", title: "a.example" },
    { url: "https://b.example/2", title: "b.example" },
  ];

  test("a verdict on fewer than the required sources becomes unverifiable and says so", () => {
    const shaped = shapeFactCheck(
      "X launched in 2019.",
      JSON.stringify({ verdict: "supported", corrected: "", note: "One page says so." }),
      two.slice(0, 1),
      { minSources: 2, maxSources: 5 },
    );
    expect(shaped.verdict).toBe("unverifiable");
    expect(shaped.thinSources).toEqual({ verdict: "supported", found: 1 });
    expect(shaped.sources).toHaveLength(1);
  });

  test("the corrected value rides only on a contradiction", () => {
    const shaped = shapeFactCheck(
      "Y costs $5.",
      JSON.stringify({ verdict: "supported", corrected: "$6", note: "Matches." }),
      two,
      { minSources: 2, maxSources: 5 },
    );
    expect(shaped.verdict).toBe("supported");
    expect(shaped.corrected).toBeUndefined();
  });

  test("sources are capped", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ url: `https://s${i}.example/`, title: `s${i}` }));
    const shaped = shapeFactCheck("Z.", JSON.stringify({ verdict: "mixed", corrected: "", note: "n" }), many, {
      minSources: 2,
      maxSources: 3,
    });
    expect(shaped.sources).toHaveLength(3);
  });

  test("an answer without a valid verdict is an error", () => {
    expect(() => shapeFactCheck("Z.", "not json", two, { minSources: 2, maxSources: 5 })).toThrow();
    expect(() =>
      shapeFactCheck("Z.", JSON.stringify({ verdict: "probably", note: "" }), two, { minSources: 2, maxSources: 5 }),
    ).toThrow();
  });
});

describe("factCheckRequestSchema", () => {
  test("holds the request to claims and an optional context", () => {
    expect(factCheckRequestSchema.safeParse({ claims: ["A"] }).success).toBe(true);
    expect(factCheckRequestSchema.safeParse({ claims: [] }).success).toBe(false);
    expect(factCheckRequestSchema.safeParse({ claims: ["A"], extra: 1 }).success).toBe(false);
    expect(factCheckRequestSchema.safeParse({ claims: ["x".repeat(501)] }).success).toBe(false);
  });
});
