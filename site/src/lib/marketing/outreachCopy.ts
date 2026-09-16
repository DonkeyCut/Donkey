import { OFFER_BUTTON_LABELS, type CreditOfferTerms } from "@/lib/credits/offerTerms";
import { fillOutreachText, type OutreachVars } from "@/lib/marketing/placeholders";
import { BUTTON_MARK, type PromotionBlock } from "@/lib/marketing/promotionCopy";

export class OutreachCopyError extends Error {}

/** Parse template syntax before inserting recipient values. */
export function renderOutreachCopy(
  subject: string,
  body: string,
  vars: OutreachVars,
  offer: CreditOfferTerms | null,
) {
  const blocks: PromotionBlock[] = [];
  let hasButton = false;
  for (const paragraph of body.replace(/\r\n/g, "\n").split(/\n[ \t]*\n/)) {
    const text = paragraph.trim();
    if (!text) continue;
    if (text === BUTTON_MARK) {
      if (!offer || typeof vars.claimUrl !== "string") {
        throw new OutreachCopyError("Turn on the credit offer to use {{button}}.");
      }
      if (!hasButton) blocks.push({ kind: "button" });
      hasButton = true;
    } else {
      if (text.includes(BUTTON_MARK)) {
        throw new OutreachCopyError("Put {{button}} in its own paragraph, with a blank line before and after it.");
      }
      blocks.push({ kind: "text", text: fillOutreachText(text, vars) });
    }
  }
  const filledSubject = fillOutreachText(subject, vars);
  if (offer && !hasButton && !/\{\{\s*claimUrl\s*\}\}/.test(`${subject}\n${body}`)) {
    throw new OutreachCopyError("A note with a credit offer needs {{button}} or {{claimUrl}} in it.");
  }
  const cta = hasButton && offer && typeof vars.claimUrl === "string"
    ? { label: OFFER_BUTTON_LABELS[offer.claim], url: vars.claimUrl }
    : null;
  const text = cta
    ? blocks.map((block) => block.kind === "text" ? block.text : `${cta.label}: ${cta.url}`).join("\n\n")
    : fillOutreachText(body, vars);
  return { subject: filledSubject, text, blocks, cta };
}
