import { describe, expect, test } from "bun:test";

import { factCheckToolOutput } from "./factCheck";
import { toToolResult, uiToolOutput } from "./pi/tools";
import { searchLinksOf, splitToolDisplay, toolDisplayOf } from "./toolDisplay";

const BLOCK =
  '<style>.chip{color:#000}</style><div class="carousel">' +
  '<a class="chip" href="https://www.google.com/search?q=eiffel+tower+height&amp;client=app-vertex-grounding">eiffel <b>tower</b> height</a>' +
  '<a class="chip" href="javascript:alert(1)">bad</a>' +
  '<a class="chip" href="https://www.google.com/search?q=eiffel+tower+height&amp;client=app-vertex-grounding">again</a>' +
  "</div>";

const supported = {
  claim: "The Eiffel Tower is in Paris.",
  verdict: "supported" as const,
  note: "Every source places it in Paris.",
  sources: [],
  searchSuggestions: BLOCK,
};

describe("check_facts output", () => {
  test("suggestions move from each result to display, once each", () => {
    const out = factCheckToolOutput([supported, { ...supported, claim: "Again." }, { claim: "Broken.", error: "failed" }]);
    expect(toolDisplayOf(out)).toEqual({ searchSuggestions: [BLOCK] });
    expect(out.results.some((r) => "searchSuggestions" in r)).toBe(false);
    expect(out.note).toContain("1 of 3");
  });

  test("a check with no suggestions has no display", () => {
    expect("display" in factCheckToolOutput([{ ...supported, searchSuggestions: undefined }])).toBe(false);
  });
});

describe("the tool bridge", () => {
  test("display reaches the UI and stays out of what the model reads", () => {
    const result = toToolResult("check_facts", factCheckToolOutput([supported]));
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).not.toContain("carousel");
    expect(JSON.stringify(result.details.response)).not.toContain("carousel");
    expect(toolDisplayOf(uiToolOutput(result.details))).toEqual({ searchSuggestions: [BLOCK] });
  });

  test("an output without display passes through unchanged", () => {
    const output = { ok: true };
    expect(splitToolDisplay(output).output).toBe(output);
    expect(uiToolOutput(toToolResult("x", output).details)).toEqual(output);
  });

  test("a malformed display is dropped", () => {
    expect(splitToolDisplay({ ok: true, display: { searchSuggestions: [1, ""] } })).toEqual({ output: { ok: true } });
  });
});

describe("search links", () => {
  test("https chips become text and URL, entities decoded, duplicates and other schemes dropped", () => {
    expect(searchLinksOf(BLOCK)).toEqual([
      {
        query: "eiffel tower height",
        url: "https://www.google.com/search?q=eiffel+tower+height&client=app-vertex-grounding",
      },
    ]);
  });
});
