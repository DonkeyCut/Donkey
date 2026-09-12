import { z } from "zod";

import { creditOfferClaimUrl, createTermsCreditOffer } from "@/lib/credits/offers";
import { clickUrl } from "@/lib/email/click";
import { recordExpiryNoticeSent } from "@/lib/email/credit-expiry-notices";
import type { EmailSendKind } from "@/lib/email/send-budget";
import { PermanentSendError } from "@/lib/email/errors";
import type { EmailKindId } from "@/lib/email/kindIds";
import type { EmailMessage, EmailUser } from "@/lib/email/resend";
import { buildCreditsExpiringEmail } from "@/lib/email/send-credits-expiring";
import { buildCreditsOfferedEmail } from "@/lib/email/send-credits-offered";
import { buildWelcomeEmail, recordWelcomeSent } from "@/lib/email/send-welcome";
import { isMarketingUnsubscribed } from "@/lib/email/unsubscribe";
import { buildReplyForwardEmail, replyForwardPayloadSchema } from "@/lib/marketing/forward-reply";
import { UnknownPlaceholderError } from "@/lib/marketing/placeholders";
import { creditOfferTermsOf } from "@/lib/credits/offerTerms";
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

// A promotion with a credit offer mails each person their own claim link and
// the last day to use it, backed by an offer row that the real send and the
// test send share. The real send's button is counted when followed.
async function promotionEmailFor(
  promotion: Awaited<ReturnType<typeof promotionRowOf>>,
  user: EmailUser,
  trackClick?: (url: string) => string,
) {
  const terms = creditOfferTermsOf(promotion.creditOffer);
  const offer = terms
    ? await createTermsCreditOffer({
        scope: promotion.id,
        userId: user.id,
        terms,
        offeredByUserId: promotion.actorUserId,
      })
    : null;
  return buildPromotionEmail(promotionCopyOf(promotion), user, offer?.vars, trackClick);
}

const promotion = define({
  quota: "bulk",
  payload: promotionPayloadSchema,
  build: async ({ promotionId }, row) => {
    const [user, promotion] = await Promise.all([userOf(row), promotionRowOf(promotionId)]);
    // The opt-out is read again right before the send, so someone who
    // unsubscribed after the segment was resolved is skipped.
    if (!user || (await isMarketingUnsubscribed(user.id))) return null;
    return promotionEmailFor(promotion, user, (url) => clickUrl(row.id, url));
  },
  onAbandon: async ({ promotionId }, _row, error) => abandonPromotion(promotionId, error),
});

// The saved copy mailed to the operator, placeholders filled with their own
// account. A credit offer gives them their own working claim link.
const promotionTest = define({
  quota: "manual",
  payload: promotionPayloadSchema,
  build: async ({ promotionId }, row) => {
    const [user, promotion] = await Promise.all([userOf(row), promotionRowOf(promotionId)]);
    if (!user) return null;
    return promotionEmailFor(promotion, user);
  },
});

// The same promotion email, sent to one person from their Outreach row. It
// spends the manual quota so it goes now, and its outbox row is keyed like
// the segment send's, so the promotion counts it and never mails the person
// again. The row's outreach entry is filed as sent, like a note.
const promotionHand = define({
  quota: "manual",
  payload: z
    .object({ promotionId: z.string().min(1), outreachId: z.string().min(1), actorUserId: z.string().min(1) })
    .strict(),
  build: async ({ promotionId }, row) => {
    const [user, promotion] = await Promise.all([userOf(row), promotionRowOf(promotionId)]);
    if (!user || (await isMarketingUnsubscribed(user.id))) return null;
    return promotionEmailFor(promotion, user, (url) => clickUrl(row.id, url));
  },
  afterSend: async ({ outreachId, actorUserId }) => recordOutreachSent({ outreachId, actorUserId }),
});

export const EMAIL_KINDS: Record<EmailKindId, EmailKind> = {
  "reply-forward": replyForward as EmailKind,
  "credit-offer": creditOffer as EmailKind,
  outreach: outreach as EmailKind,
  "promotion-hand": promotionHand as EmailKind,
  "promotion-test": promotionTest as EmailKind,
  welcome: welcome as EmailKind,
  "credit-expiry": creditExpiry as EmailKind,
  promotion: promotion as EmailKind,
};
