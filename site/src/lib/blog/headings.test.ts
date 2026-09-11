import { describe, expect, test } from "bun:test";

import { extractHeadings, headingId } from "@/lib/blog/headings";

describe("headingId", () => {
  test("lowercases, hyphenates and keeps ampersands readable", () => {
    expect(headingId("Cuts & Transitions: the basics")).toBe("cuts-and-transitions-the-basics");
  });
});

describe("extractHeadings", () => {
  test("lists h2 and h3 in order, skipping fences and other levels", () => {
    const source = [
      "# Title",
      "## First section",
      "text",
      "### A *sub* point",
      "```",
      "## not a heading",
      "```",
      "#### too deep",
      "## FAQs",
    ].join("\n");
    expect(extractHeadings(source)).toEqual([
      { id: "first-section", text: "First section", level: 2 },
      { id: "a-sub-point", text: "A sub point", level: 3 },
      { id: "faqs", text: "FAQs", level: 2 },
    ]);
  });
});
