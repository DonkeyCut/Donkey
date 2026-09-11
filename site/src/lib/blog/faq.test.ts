import { describe, expect, test } from "bun:test";

import { extractFaqItems } from "./faq";

describe("extractFaqItems", () => {
  test("reads questions and answers under the FAQs heading", () => {
    const source = [
      "## How it works",
      "Some prose.",
      "## FAQs",
      "### Is it free?",
      "Yes, **completely** free.",
      "",
      "### Does it run offline?",
      "It does, see [the guide](/install).",
      "## Conclusion",
      "### Not a question",
      "Nope.",
    ].join("\n");
    expect(extractFaqItems(source)).toEqual([
      { question: "Is it free?", answer: "Yes, completely free." },
      { question: "Does it run offline?", answer: "It does, see the guide." },
    ]);
  });

  test("no FAQs section means no items", () => {
    expect(extractFaqItems("## Intro\n### A heading\nText")).toEqual([]);
  });

  test("a question with no answer is dropped", () => {
    expect(extractFaqItems("## FAQ\n### Empty?\n### Full?\nAn answer.")).toEqual([
      { question: "Full?", answer: "An answer." },
    ]);
  });
});
