import { Prisma } from "@/generated/prisma/client";
import { invalidResponse } from "@/lib/config/experimentList";
import { UnknownPlaceholderError } from "@/lib/marketing/placeholders";
import { renderPromotion, SAMPLE_RECIPIENT } from "@/lib/marketing/promotionCopy";
import {
  promotionInputSchema,
  type PromotionDraftInput,
  type PromotionInput,
} from "@/lib/marketing/promotionInput";

// What a save of a promotion shares between create and edit: the row data a
// draft maps to. What a test or a send checks first: the stored row parsed as
// a complete promotion, and its copy rendered for a stand-in recipient, so a
// blank field or a placeholder typo comes back to the form and never reaches
// a mailbox. The claim link and its last day are minted per person at the
// send, so the check fills them blank.

export function copyIssue(input: PromotionInput): Response | null {
  try {
    renderPromotion(input, SAMPLE_RECIPIENT, input.creditOffer ? { claimUrl: "", claimBy: "" } : undefined);
    return null;
  } catch (error) {
    if (error instanceof UnknownPlaceholderError) {
      return invalidResponse([{ path: ["body"], message: error.message }]);
    }
    throw error;
  }
}

export function sendIssue(row: {
  name: string;
  subject: string;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  creditOffer: Prisma.JsonValue;
  sender: string;
  audience: Prisma.JsonValue;
  excludePromotionIds: string[];
}): Response | null {
  const parsed = promotionInputSchema.safeParse({
    name: row.name,
    subject: row.subject,
    body: row.body,
    ctaLabel: row.ctaLabel,
    ctaUrl: row.ctaUrl,
    creditOffer: row.creditOffer,
    sender: row.sender,
    audience: row.audience,
    excludePromotionIds: row.excludePromotionIds,
  });
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  return copyIssue(parsed.data);
}

export function promotionData(input: PromotionDraftInput, actorUserId: string) {
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
