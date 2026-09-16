import { describe, expect, test } from "bun:test";
import { render } from "react-email";

import OutreachEmail from "@/emails/outreach";
import { type CreditOfferTerms } from "@/lib/credits/offerTerms";
import { renderOutreachCopy } from "@/lib/marketing/outreachCopy";

const vars = {
  balance: "0", email: "ada@example.com", firstName: "Ada", name: "Ada Lovelace",
  spent: "2.4", storage: "120 MB", claimUrl: "https://example.com/app?claim=test&source=email", claimBy: "September 30",
};
const offer: CreditOfferTerms = { dollars: 60, claim: "subscribe", claimWindowDays: 3, expiresAfterDays: 30 };

describe("outreach claim button", () => {
  test("accepts the note's button without a separate claimUrl placeholder", async () => {
    const copy = renderOutreachCopy("Low on credits?", "Hey {{firstName}},\n\nSubscribe for $60 in credits.\n\n{{button}}", vars, offer);
    expect(copy.cta).toEqual({ label: "Subscribe to Pro", url: vars.claimUrl });
    expect(copy.blocks.at(-1)).toEqual({ kind: "button" });
    expect(copy.text).toContain(`Subscribe to Pro: ${vars.claimUrl}`);
    expect(copy.text).not.toContain("{{");
    const html = await render(<OutreachEmail blocks={copy.blocks} cta={copy.cta!} unsubscribeUrl="https://example.com/unsubscribe" />);
    expect(html).toContain("Subscribe to Pro");
    expect(html).toContain('href="https://example.com/app?claim=test&amp;source=email"');
    expect(html).toContain("background-color:#0F0E0D");
    expect(html).toContain("Unsubscribe from product emails");
  });

  test("direct claims use their own label and repeated markers place one button", () => {
    const copy = renderOutreachCopy("Credits", "{{button}}\r\n\r\nThanks!\r\n\r\n{{button}}", vars, { ...offer, claim: "link" });
    expect(copy.cta?.label).toBe("Claim my AI credits");
    expect(copy.blocks.filter((block) => block.kind === "button")).toHaveLength(1);
  });

  test("requires an offer, a claim URL, and a standalone marker", () => {
    expect(() => renderOutreachCopy("Credits", "{{button}}", vars, null)).toThrow("Turn on the credit offer");
    expect(() => renderOutreachCopy("Credits", "{{button}}", { ...vars, claimUrl: undefined }, offer)).toThrow("Turn on the credit offer");
    expect(() => renderOutreachCopy("Credits", "Click {{button}}", vars, offer)).toThrow("own paragraph");
    expect(() => renderOutreachCopy("Credits", "Hello", vars, offer)).toThrow("needs {{button}} or {{claimUrl}}");
    expect(() => renderOutreachCopy("{{button}}", "{{claimUrl}}", vars, offer)).toThrow("Unknown placeholder");
  });

  test("keeps plain notes and URL placeholders as text", () => {
    const body = "Hey {{firstName}},\n\n\nClaim here: {{ claimUrl }}";
    const copy = renderOutreachCopy("Credits", body, vars, offer);
    expect(copy.cta).toBeNull();
    expect(copy.text).toBe(`Hey Ada,\n\n\nClaim here: ${vars.claimUrl}`);
    expect(renderOutreachCopy("Hello", "Plain note", vars, null).text).toBe("Plain note");
  });

  test("escapes recipient text and omits the disabled unsubscribe footer", async () => {
    const copy = renderOutreachCopy("Credits", "Hey {{name}},\nA second line.\n\n{{button}}", { ...vars, name: '<img src="x"> {{button}}' }, offer);
    const html = await render(<OutreachEmail blocks={copy.blocks} cta={copy.cta!} unsubscribeUrl={null} />);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain('<img src="x">');
    expect(html).toContain("<br");
    expect(html).not.toContain("Unsubscribe");
  });
});
