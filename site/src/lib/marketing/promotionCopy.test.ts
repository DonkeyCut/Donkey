import { describe, expect, test } from "bun:test";

import { UnknownPlaceholderError } from "./placeholders";
import { promotionBlocks, renderPromotion, SAMPLE_RECIPIENT } from "./promotionCopy";

const copy = {
  subject: "{{firstName}}, 5x AI on Pro",
  body: "Hey {{firstName}},\n\nGet Pro before October 29.\nEvery month includes $100 of AI.\n\n{{button}}\n\nDavid",
  ctaLabel: "Get Pro",
  ctaUrl: "https://donkeycut.com/app/settings",
  sender: "bulk" as const,
};

describe("promotionBlocks", () => {
  test("splits at blank lines and keeps a line break inside a paragraph", () => {
    expect(promotionBlocks("one\ntwo\n\n\nthree", false)).toEqual([
      { kind: "text", text: "one\ntwo" },
      { kind: "text", text: "three" },
    ]);
  });

  test("places the button where the mark is, once", () => {
    expect(promotionBlocks("a\n\n{{button}}\n\nb\n\n{{button}}", true)).toEqual([
      { kind: "text", text: "a" },
      { kind: "button" },
      { kind: "text", text: "b" },
    ]);
  });

  test("a credit offer fills its link and last day", () => {
    const rendered = renderPromotion(
      { ...copy, body: "Subscribe by {{claimBy}}.", ctaUrl: "{{claimUrl}}" },
      SAMPLE_RECIPIENT,
      { claimUrl: "https://donkeycut.com/app?claim=t", claimBy: "September 30, 2026" },
    );
    expect(rendered.blocks[0]).toEqual({ kind: "text", text: "Subscribe by September 30, 2026." });
    expect(rendered.cta?.url).toBe("https://donkeycut.com/app?claim=t");
  });

  test("a body without the mark gets the button last", () => {
    expect(promotionBlocks("a\n\nb", true)).toEqual([
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
      { kind: "button" },
    ]);
  });

  test("the mark is dropped when there is no button", () => {
    expect(promotionBlocks("a\n\n{{button}}", false)).toEqual([{ kind: "text", text: "a" }]);
  });
});

describe("renderPromotion", () => {
  test("fills the subject, body and button label for the recipient", () => {
    const rendered = renderPromotion(copy, SAMPLE_RECIPIENT);
    expect(rendered.subject).toBe("Ada, 5x AI on Pro");
    expect(rendered.blocks).toEqual([
      { kind: "text", text: "Hey Ada," },
      { kind: "text", text: "Get Pro before October 29.\nEvery month includes $100 of AI." },
      { kind: "button" },
      { kind: "text", text: "David" },
    ]);
    expect(rendered.cta).toEqual({ label: "Get Pro", url: copy.ctaUrl });
    expect(rendered.preview).toBe("Hey Ada,");
  });

  test("an unknown placeholder refuses the copy", () => {
    let refused = false;
    try {
      renderPromotion({ ...copy, body: "{{balance}}" }, SAMPLE_RECIPIENT);
    } catch (e) {
      refused = e instanceof UnknownPlaceholderError;
    }
    expect(refused).toBe(true);
  });

  test("no button leaves the body as paragraphs", () => {
    const rendered = renderPromotion({ ...copy, ctaLabel: null, ctaUrl: null }, SAMPLE_RECIPIENT);
    expect(rendered.cta).toBeNull();
    expect(rendered.blocks.some((b) => b.kind === "button")).toBe(false);
  });
});
