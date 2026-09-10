import { Prisma } from "@/generated/prisma/client";
import { invalidResponse } from "@/lib/config/experimentList";
import { UnknownPlaceholderError } from "@/lib/marketing/placeholders";
import { renderPromotion, SAMPLE_RECIPIENT } from "@/lib/marketing/promotionCopy";
import type { PromotionInput } from "@/lib/marketing/promotionInput";

// What a save of a promotion shares between create and edit: the copy is
// rendered for a stand-in recipient, so a placeholder typo is refused at the
// save and never reaches a send; and the row data the input maps to. The
// claim link is minted per person at the send, so the check fills it blank.

export function copyIssue(input: PromotionInput): Response | null {
  try {
    renderPromotion(input, SAMPLE_RECIPIENT, input.creditOffer ? "" : undefined);
    return null;
  } catch (error) {
    if (error instanceof UnknownPlaceholderError) {
      return invalidResponse([{ path: ["body"], message: error.message }]);
    }
    throw error;
  }
}

export function promotionData(input: PromotionInput, actorUserId: string) {
  return {
    actorUserId,
    creditOffer: input.creditOffer ? (input.creditOffer as Prisma.InputJsonValue) : Prisma.DbNull,
    audience: input.audience as Prisma.InputJsonValue,
    body: input.body,
    ctaLabel: input.ctaLabel,
    ctaUrl: input.ctaUrl,
    excludePromotionIds: input.excludePromotionIds,
    name: input.name,
    sender: input.sender,
    subject: input.subject,
  };
}
