import { audienceNeeds, audienceSchema, matchesAudience, type Audience } from "@donkeycut/abexp";

import type { Prisma } from "@/generated/prisma/client";
import { DONKEY_LOGO_CID, DONKEY_LOGO_PNG_BASE64 } from "@/emails/_components/logo";
import PromotionEmail from "@/emails/promotion";
import { collectFactsFor } from "@/lib/config/audienceFacts";
import { bulkFrom, emailFrom, type EmailMessage, type EmailUser } from "@/lib/email/resend";
import { PermanentSendError } from "@/lib/email/errors";
import { unsubscribeActionUrl, unsubscribePageUrl } from "@/lib/email/unsubscribe";
import { renderPromotion, type PromotionCopy } from "@/lib/marketing/promotionCopy";
import {
  PROMOTION_SENDERS,
  PROMOTION_STATUSES,
  type PromotionSender,
  type PromotionStatus,
  type PromotionSummary,
  type SegmentCount,
} from "@/lib/marketing/promotionInput";
import { prisma } from "@/lib/prisma";
import { PROMOTION_OFFER_KINDS } from "@/lib/credits/offerKinds";
import type { OfferVars } from "@/lib/credits/offerTerms";
import { creditOfferTermsOf } from "@/lib/credits/offerTerms";

// Promotions on the server: which address each sender is, who a segment
// resolves to, one send, and the list su reads.

/** The address each sender name stands for. Empty when unconfigured. */
export function promotionSenders(): Record<PromotionSender, string> {
  return { bulk: bulkFrom(), personal: emailFrom() };
}

const isSender = (s: string): s is PromotionSender => (PROMOTION_SENDERS as readonly string[]).includes(s);
const isStatus = (s: string): s is PromotionStatus => (PROMOTION_STATUSES as readonly string[]).includes(s);

function senderOf(value: string): PromotionSender {
  if (!isSender(value)) throw new Error(`Unknown promotion sender "${value}".`);
  return value;
}

function statusOf(value: string): PromotionStatus {
  if (!isStatus(value)) throw new Error(`Unknown promotion status "${value}".`);
  return value;
}

export function promotionCopyOf(row: {
  subject: string;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  sender: string;
}): PromotionCopy {
  return { subject: row.subject, body: row.body, ctaLabel: row.ctaLabel, ctaUrl: row.ctaUrl, sender: senderOf(row.sender) };
}

// A stored audience that no longer parses is an error: widening a send to
// everyone is the one thing a bad row must never do.
export function promotionAudienceOf(raw: Prisma.JsonValue): Audience {
  return audienceSchema.parse(raw);
}

/** One promotion email for one account. The idempotency key is the row's:
 * the outbox keys on the recipient so a retried run cannot mail anyone twice. */
export function buildPromotionEmail(
  copy: PromotionCopy,
  user: EmailUser,
  offer: OfferVars | undefined,
  // Wraps the button's link so the follow is counted; the test send has none.
  trackClick?: (url: string) => string,
): EmailMessage {
  const from = promotionSenders()[copy.sender];
  if (!from) throw new PermanentSendError(`The ${copy.sender} sender is not configured.`);
  const rendered = renderPromotion(copy, user, offer);
  const cta = rendered.cta && trackClick ? { ...rendered.cta, url: trackClick(rendered.cta.url) } : rendered.cta;
  return {
    from,
    to: user.email,
    replyTo: emailFrom() || from,
    subject: rendered.subject,
    react: PromotionEmail({
      blocks: rendered.blocks,
      cta,
      preview: rendered.preview,
      unsubscribeUrl: unsubscribePageUrl(user.id),
    }),
    attachments: [
      {
        content: DONKEY_LOGO_PNG_BASE64,
        contentId: DONKEY_LOGO_CID,
        contentType: "image/png",
        filename: "donkey-cut.png",
      },
    ],
    headers: {
      "List-Unsubscribe": `<${unsubscribeActionUrl(user.id)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

export type PromotionSegment = { audience: Audience; excludePromotionIds: string[] };

export type SegmentResolution = SegmentCount & {
  // Where the walk stopped: the last account read when the deadline came,
  // null once the whole list was seen. A caller resumes by passing it back.
  cursor: string | null;
};

export type ResolveOptions = {
  now?: Date;
  // Resume from an earlier call's cursor.
  cursor?: string;
  // A time (ms since epoch) after which no further page is read.
  deadline?: number;
  // Receives each page of recipients as it is found. Returning false stops
  // the walk, leaving the cursor on that page.
  onPage?: (users: EmailUser[]) => Promise<boolean | void>;
};

const USER_PAGE = 500;

/** Everyone a segment reaches: the accounts the audience rules admit, less
 * the unsubscribed, less the recipients of the excluded promotions. The list
 * is read a page at a time and every fact is one set query over the page,
 * so a segment of any size costs a handful of statements per page and holds
 * one page in memory. The counts describe the pages this call walked; those
 * left out are taken inside the audience, so they describe the segment.
 * Country is never known here, so a countries rule admits nobody. */
export async function resolvePromotionSegment(
  segment: PromotionSegment,
  { now = new Date(), cursor, deadline, onPage }: ResolveOptions = {},
): Promise<SegmentResolution> {
  const needs = audienceNeeds(segment.audience);
  const result: SegmentResolution = { cursor: null, recipients: 0, unsubscribed: 0, alreadyReceived: 0, outsideAudience: 0 };
  let last = cursor;
  for (;;) {
    const page = await prisma.user.findMany({
      orderBy: { id: "asc" },
      select: {
        createdAt: true,
        email: true,
        emailSettings: { select: { marketingUnsubscribedAt: true } },
        id: true,
        name: true,
      },
      take: USER_PAGE,
      ...(last ? { cursor: { id: last }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    const ids = page.map((u) => u.id);
    const [facts, receivedRows] = await Promise.all([
      collectFactsFor(page.map((u) => ({ id: u.id, country: null, createdAt: u.createdAt })), needs),
      segment.excludePromotionIds.length > 0
        ? prisma.emailSend.findMany({
            distinct: ["userId"],
            select: { userId: true },
            where: { promotionId: { in: segment.excludePromotionIds }, state: "sent", userId: { in: ids } },
          })
        : [],
    ]);
    const received = new Set(receivedRows.map((r) => r.userId));
    const users: EmailUser[] = [];
    for (const user of page) {
      if (!matchesAudience(segment.audience, facts.get(user.id)!, now)) result.outsideAudience++;
      else if (user.emailSettings?.marketingUnsubscribedAt) result.unsubscribed++;
      else if (received.has(user.id)) result.alreadyReceived++;
      else users.push({ email: user.email, id: user.id, name: user.name });
    }
    result.recipients += users.length;
    last = page[page.length - 1].id;
    if (onPage && (await onPage(users)) === false) {
      result.cursor = last;
      return result;
    }
    if (page.length < USER_PAGE) break;
    if (deadline !== undefined && Date.now() >= deadline) {
      result.cursor = last;
      return result;
    }
  }
  return result;
}

type PromotionRow = NonNullable<Awaited<ReturnType<typeof prisma.promotion.findUnique>>>;

function summarize(row: PromotionRow, counts: PromotionSummary["counts"]): PromotionSummary {
  return {
    id: row.id,
    creditOffer: creditOfferTermsOf(row.creditOffer),
    name: row.name,
    subject: row.subject,
    body: row.body,
    ctaLabel: row.ctaLabel,
    ctaUrl: row.ctaUrl,
    sender: senderOf(row.sender),
    audience: promotionAudienceOf(row.audience),
    excludePromotionIds: row.excludePromotionIds,
    status: statusOf(row.status),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    counts,
  };
}

/** Every promotion, newest first, with how far its send got and what came
 * of it: buttons followed, and credit offers claimed. */
export async function listPromotions(): Promise<PromotionSummary[]> {
  const [rows, all, sent, failed, clicked, claimedOffers] = await Promise.all([
    prisma.promotion.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.emailSend.groupBy({ _count: true, by: ["promotionId"], where: { promotionId: { not: null } } }),
    prisma.emailSend.groupBy({ _count: true, by: ["promotionId"], where: { promotionId: { not: null }, state: "sent" } }),
    prisma.emailSend.groupBy({
      _count: true,
      by: ["promotionId"],
      where: { promotionId: { not: null }, state: { in: ["failed", "skipped"] } },
    }),
    prisma.emailSend.groupBy({
      _count: true,
      by: ["promotionId"],
      where: { clickedAt: { not: null }, promotionId: { not: null } },
    }),
    // A promotion's offers are keyed `${promotionId}:${userId}`.
    prisma.creditOffer.findMany({
      select: { id: true },
      where: { claimedAt: { not: null }, kind: { in: [...PROMOTION_OFFER_KINDS] } },
    }),
  ]);
  const countOf = (groups: { promotionId: string | null; _count: number }[]) =>
    new Map(groups.flatMap((g) => (g.promotionId ? [[g.promotionId, g._count] as const] : [])));
  const recipients = countOf(all);
  const sentBy = countOf(sent);
  const failedBy = countOf(failed);
  const clickedBy = countOf(clicked);
  const claimedBy = new Map<string, number>();
  for (const offer of claimedOffers) {
    const promotionId = offer.id.slice(0, offer.id.indexOf(":"));
    claimedBy.set(promotionId, (claimedBy.get(promotionId) ?? 0) + 1);
  }
  return rows.map((row) =>
    summarize(row, {
      recipients: recipients.get(row.id) ?? 0,
      sent: sentBy.get(row.id) ?? 0,
      failed: failedBy.get(row.id) ?? 0,
      clicked: clickedBy.get(row.id) ?? 0,
      claimed: claimedBy.get(row.id) ?? 0,
    }),
  );
}
