import { z } from "zod";

import { creditOfferClaimUrl, createPromotionCreditOffer } from "@/lib/credits/offers";
import { recordExpiryNoticeSent } from "@/lib/email/credit-expiry-notices";
import type { EmailSendKind } from "@/lib/email/daily-send-limit";
import { PermanentSendError } from "@/lib/email/errors";
import type { EmailKindId } from "@/lib/email/kindIds";
import type { EmailMessage, EmailUser } from "@/lib/email/resend";
import { buildCreditsExpiringEmail } from "@/lib/email/send-credits-expiring";
import { buildCreditsOfferedEmail } from "@/lib/email/send-credits-offered";
import { buildWelcomeEmail, recordWelcomeSent } from "@/lib/email/send-welcome";
import { isMarketingUnsubscribed } from "@/lib/email/unsubscribe";
import { buildReplyForwardEmail, replyForwardPayloadSchema } from "@/lib/marketing/forward-reply";
import { UnknownPlaceholderError } from "@/lib/marketing/placeholders";
import { SAMPLE_CLAIM_URL, promotionOfferOf } from "@/lib/marketing/promotionOfferInput";
import { buildPromotionEmail, promotionCopyOf } from "@/lib/marketing/promotions";
import { buildOutreachEmail, outreachPayloadSchema, recordOutreachSent } from "@/lib/marketing/send-outreach";
import { prisma } from "@/lib/prisma";

// What each kind of email is on the server: whose quota it spends, what its
// payload holds, how the message is built, and what to write down once it
// went. A new kind is an entry here plus its id and priority in kindIds.ts.

export type OutboxRow = {
  id: string;
  userId: string | null;
  promotionId: string | null;
  idempotencyKey: string;
};

export type EmailKind<P = unknown> = {
  quota: EmailSendKind;
  payload: z.ZodType<P>;
  // The message for the provider, or null when nothing should go out any
  // more (the account is gone or opted out): the row is dropped as skipped.
  build: (payload: P, row: OutboxRow) => Promise<EmailMessage | null>;
  // Bookkeeping once the provider accepted the message.
  afterSend?: (payload: P, row: OutboxRow) => Promise<void>;
  // Bookkeeping when the row is given up for good.
  onAbandon?: (payload: P, row: OutboxRow, error: Error) => Promise<void>;
};

function define<P>(kind: EmailKind<P>): EmailKind<P> {
  return kind;
}

const USER_SELECT = { email: true, id: true, name: true } as const;

async function userOf(row: OutboxRow): Promise<EmailUser | null> {
  if (!row.userId) throw new PermanentSendError("This email needs an account.");
  return prisma.user.findUnique({ select: USER_SELECT, where: { id: row.userId } });
}

const welcome = define({
  quota: "transactional",
  payload: z.object({ credits: z.string().nullable() }).strict(),
  build: async ({ credits }, row) => {
    const user = await userOf(row);
    return user ? buildWelcomeEmail(user, credits) : null;
  },
  afterSend: async (_payload, row) => recordWelcomeSent(row.userId!),
});

const creditExpiry = define({
  quota: "transactional",
  payload: z.object({ credits: z.string(), grantId: z.string().min(1) }).strict(),
  build: async ({ credits, grantId }, row) => {
    const [user, grant] = await Promise.all([
      userOf(row),
      prisma.userCreditGrant.findUnique({ select: { expiresAt: true, status: true }, where: { id: grantId } }),
    ]);
    if (!user || !grant?.expiresAt || grant.status !== "active") return null;
    return buildCreditsExpiringEmail(user, credits, grant.expiresAt);
  },
  afterSend: async ({ grantId }) => recordExpiryNoticeSent(grantId),
});

const creditOffer = define({
  quota: "manual",
  payload: z.object({ offerId: z.string().min(1) }).strict(),
  build: async ({ offerId }, row) => {
    const [user, offer] = await Promise.all([userOf(row), prisma.creditOffer.findUnique({ where: { id: offerId } })]);
    if (!user || !offer || offer.claimedAt || !offer.closesAt) return null;
    return buildCreditsOfferedEmail(user, {
      amountMicros: offer.amountMicros,
      claimUrl: creditOfferClaimUrl(offer.id),
      closesAt: offer.closesAt,
      expiresAfterDays: offer.expiresAfterDays,
    });
  },
  afterSend: async ({ offerId }) => {
    await prisma.creditOffer.update({ data: { emailSentAt: new Date() }, where: { id: offerId } });
  },
});

const outreach = define({
  quota: "manual",
  payload: outreachPayloadSchema,
  build: async (payload, row) => {
    const user = await userOf(row);
    return user ? buildOutreachEmail(payload, user) : null;
  },
  afterSend: async (payload) => recordOutreachSent(payload),
});

const replyForward = define({
  quota: "manual",
  payload: replyForwardPayloadSchema,
  build: (payload) => buildReplyForwardEmail(payload),
});

const promotionPayloadSchema = z.object({ promotionId: z.string().min(1) }).strict();

async function promotionRowOf(promotionId: string) {
  const promotion = await prisma.promotion.findUnique({ where: { id: promotionId } });
  if (!promotion) throw new PermanentSendError("The promotion no longer exists.");
  return promotion;
}

// A copy error is permanent for the whole send: the draft comes back so the
// operator can fix it, and the unsent rows go with it.
async function abandonPromotion(promotionId: string, error: Error): Promise<void> {
  if (!(error instanceof PermanentSendError || error instanceof UnknownPlaceholderError)) return;
  await prisma.emailSend.deleteMany({ where: { promotionId, state: "queued" } });
  await prisma.promotion.update({ data: { status: "draft" }, where: { id: promotionId } });
}

const promotion = define({
  quota: "bulk",
  payload: promotionPayloadSchema,
  build: async ({ promotionId }, row) => {
    const [user, promotion] = await Promise.all([userOf(row), promotionRowOf(promotionId)]);
    // The opt-out is read again right before the send, so someone who
    // unsubscribed after the segment was resolved is skipped.
    if (!user || (await isMarketingUnsubscribed(user.id))) return null;
    const offer = promotionOfferOf(promotion.creditOffer);
    const claimUrl = offer
      ? (
          await createPromotionCreditOffer({
            promotionId,
            userId: user.id,
            amountDollars: offer.dollars,
            claimWindowDays: offer.claimWindowDays,
            expiresAfterDays: offer.expiresAfterDays,
            offeredByUserId: promotion.actorUserId,
          })
        ).claimUrl
      : undefined;
    return buildPromotionEmail(promotionCopyOf(promotion), user, claimUrl);
  },
  onAbandon: async ({ promotionId }, _row, error) => abandonPromotion(promotionId, error),
});

// The saved copy mailed to the operator, placeholders filled with their own
// account and a sample claim link where the copy has one.
const promotionTest = define({
  quota: "manual",
  payload: promotionPayloadSchema,
  build: async ({ promotionId }, row) => {
    const [user, promotion] = await Promise.all([userOf(row), promotionRowOf(promotionId)]);
    if (!user) return null;
    return buildPromotionEmail(promotionCopyOf(promotion), user, promotion.creditOffer ? SAMPLE_CLAIM_URL : undefined);
  },
});

export const EMAIL_KINDS: Record<EmailKindId, EmailKind> = {
  "reply-forward": replyForward as EmailKind,
  "credit-offer": creditOffer as EmailKind,
  outreach: outreach as EmailKind,
  "promotion-test": promotionTest as EmailKind,
  welcome: welcome as EmailKind,
  "credit-expiry": creditExpiry as EmailKind,
  promotion: promotion as EmailKind,
};
