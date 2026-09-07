import type { EmailUser } from "@/lib/email/resend";
import {
  fillPromotionText,
  firstNameOf,
  type PromotionVars,
} from "@/lib/marketing/placeholders";
import type { PromotionSender } from "@/lib/marketing/promotionInput";

// The words of a promotion, turned into what one recipient reads: the subject
// and body with placeholders filled, the body cut into paragraphs, and the
// button placed. Pure, so the send, the test send and the tests share it.

export type PromotionCopy = {
  subject: string;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  sender: PromotionSender;
};

export type PromotionBlock = { kind: "text"; text: string } | { kind: "button" };

/** A paragraph that is only this places the button there. */
export const BUTTON_MARK = "{{button}}";

/** Splits a body into paragraphs at blank lines. With a button, the first
 * paragraph reading `{{button}}` places it; without one it follows the last
 * paragraph. A line break inside a paragraph is kept. */
export function promotionBlocks(body: string, hasButton: boolean): PromotionBlock[] {
  const blocks: PromotionBlock[] = [];
  let placed = false;
  for (const raw of body.replace(/\r\n/g, "\n").split(/\n[ \t]*\n/)) {
    const text = raw.trim();
    if (!text) continue;
    if (text === BUTTON_MARK) {
      if (hasButton && !placed) {
        blocks.push({ kind: "button" });
        placed = true;
      }
      continue;
    }
    blocks.push({ kind: "text", text });
  }
  if (hasButton && !placed) blocks.push({ kind: "button" });
  return blocks;
}

export function promotionVars(user: EmailUser): PromotionVars {
  return { firstName: firstNameOf(user.name), name: user.name, email: user.email };
}

export type RenderedPromotion = {
  subject: string;
  blocks: PromotionBlock[];
  cta: { label: string; url: string } | null;
  // The inbox preview line: the first line of the body.
  preview: string;
};

/** What one recipient reads. Throws UnknownPlaceholderError on a typo, so a
 * save or a send fails before any mail leaves. */
export function renderPromotion(copy: PromotionCopy, user: EmailUser): RenderedPromotion {
  const vars = promotionVars(user);
  const subject = fillPromotionText(copy.subject, vars);
  const cta =
    copy.ctaLabel !== null && copy.ctaUrl !== null
      ? { label: fillPromotionText(copy.ctaLabel, vars), url: copy.ctaUrl }
      : null;
  const body = fillPromotionText(copy.body.replaceAll(BUTTON_MARK, "\u0000button\u0000"), vars).replaceAll(
    "\u0000button\u0000",
    BUTTON_MARK,
  );
  const blocks = promotionBlocks(body, cta !== null);
  const first = blocks.find((b): b is { kind: "text"; text: string } => b.kind === "text");
  return { subject, blocks, cta, preview: first ? first.text.split("\n")[0] : subject };
}

/** A stand-in recipient, for validating copy and for the test send. */
export const SAMPLE_RECIPIENT: EmailUser = { id: "sample", email: "ada@example.com", name: "Ada Lovelace" };
