import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { markClassicScrollbars, SCROLLBARS_HEAD_SCRIPT } from "@/lib/scrollbars";

const STYLESHEETS = ["../app/globals.css", "../clients/chatgpt/ui/preview.css"];
const THIN_MAX_PX = 10;

// A page whose probe reports the given scrollbar gutter.
function fakeDocument(gutter: number) {
  const root = { dataset: {} as Record<string, string>, appendChild: () => {} };
  const probe = { style: { cssText: "" }, offsetWidth: 50, clientWidth: 50 - gutter, remove: () => {} };
  return { documentElement: root, createElement: () => probe } as unknown as Document;
}

describe("classic scrollbars", () => {
  test("a page with classic bars is flagged", () => {
    const doc = fakeDocument(15);
    markClassicScrollbars(doc);
    expect(doc.documentElement.dataset.scrollbars).toBe("classic");
  });

  test("overlay bars stay native", () => {
    const doc = fakeDocument(0);
    markClassicScrollbars(doc);
    expect(doc.documentElement.dataset.scrollbars).toBeUndefined();
  });

  test("the head script runs the same check", () => {
    expect(SCROLLBARS_HEAD_SCRIPT).toContain("classic");
  });

  // Every surface draws classic bars as the thin ScrollArea hairline.
  for (const file of STYLESHEETS) {
    test(`${file} draws flagged bars thin`, () => {
      const css = postcss.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
      const widths: number[] = [];
      css.walkRules((rule) => {
        if (!rule.selector.includes("[data-scrollbars=classic]") || !rule.selector.endsWith("::-webkit-scrollbar")) {
          return;
        }
        rule.walkDecls("width", (decl) => { widths.push(parseFloat(decl.value)); });
      });
      expect(widths.length).toBeGreaterThan(0);
      expect(Math.max(...widths)).toBeLessThanOrEqual(THIN_MAX_PX);
    });
  }
});
