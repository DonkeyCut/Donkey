import { audienceNeeds, audienceSchema, matchesAudience, type Audience } from "@donkeycut/abexp";

import type { Prisma } from "@/generated/prisma/client";
import { DONKEY_LOGO_CID, DONKEY_LOGO_PNG_BASE64 } from "@/emails/_components/logo";
import PromotionEmail from "@/emails/promotion";
import { collectFacts } from "@/lib/config/audienceFacts";
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
import { promotionOfferOf } from "@/lib/marketing/promotionOfferInput";

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
export function buildPromotionEmail(copy: PromotionCopy, user: EmailUser, claimUrl: string | undefined): EmailMessage {
  const from = promotionSenders()[copy.sender];
  if (!from) throw new PermanentSendError(`The ${copy.sender} sender is not configured.`);
  const rendered = renderPromotion(copy, user, claimUrl);
  return {
    from,
    to: user.email,
    replyTo: emailFrom() || from,
    subject: rendered.subject,
    react: PromotionEmail({
      blocks: rendered.blocks,
      cta: rendered.cta,
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

export type SegmentResolution = SegmentCount & { users: EmailUser[] };

const USER_PAGE = 500;
const FACTS_CONCURRENCY = 10;

/** Everyone a segment reaches: the accounts the audience rules admit, less
 * the unsubscribed, less the recipients of the excluded promotions. The
 * counts of those left out are taken inside the audience, so they describe
 * the segment. Country is never known here, so a countries rule admits
 * nobody. */
export async function resolvePromotionSegment(
  segment: PromotionSegment,
  now = new Date(),
): Promise<SegmentResolution> {
  const [unsubscribedRows, receivedRows] = await Promise.all([
    prisma.userEmailSettings.findMany({
      select: { userId: true },
      where: { marketingUnsubscribedAt: { not: null } },
    }),
    segment.excludePromotionIds.length > 0
      ? prisma.emailSend.findMany({
          distinct: ["userId"],
          select: { userId: true },
          where: { promotionId: { in: segment.excludePromotionIds }, state: "sent" },
        })
      : Promise.resolve([]),
  ]);
  const unsubscribed = new Set(unsubscribedRows.map((r) => r.userId));
  const received = new Set(receivedRows.map((r) => r.userId));
  const needs = audienceNeeds(segment.audience);

  const result: SegmentResolution = {
    users: [],
    recipients: 0,
    unsubscribed: 0,
    alreadyReceived: 0,
    outsideAudience: 0,
  };
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.user.findMany({
      orderBy: { id: "asc" },
      select: { createdAt: true, email: true, id: true, name: true },
      take: USER_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (let i = 0; i < page.length; i += FACTS_CONCURRENCY) {
      const slice = page.slice(i, i + FACTS_CONCURRENCY);
      const matched = await Promise.all(
        slice.map(async (user) => {
          const facts = await collectFacts(user.id, { country: null, createdAt: user.createdAt }, needs);
          return matchesAudience(segment.audience, facts, now);
        }),
      );
      slice.forEach((user, j) => {
        if (!matched[j]) result.outsideAudience++;
        else if (unsubscribed.has(user.id)) result.unsubscribed++;
        else if (received.has(user.id)) result.alreadyReceived++;
        else result.users.push({ email: user.email, id: user.id, name: user.name });
      });
    }
  }
  result.recipients = result.users.length;
  return result;
}

type PromotionRow = NonNullable<Awaited<ReturnType<typeof prisma.promotion.findUnique>>>;

function summarize(
  row: PromotionRow,
  counts: { recipients: number; sent: number; failed: number },
): PromotionSummary {
  return {
    id: row.id,
    creditOffer: promotionOfferOf(row.creditOffer),
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

/** Every promotion, newest first, with how far its send got. */
export async function listPromotions(): Promise<PromotionSummary[]> {
  const [rows, all, sent, failed] = await Promise.all([
    prisma.promotion.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.emailSend.groupBy({ _count: true, by: ["promotionId"], where: { promotionId: { not: null } } }),
    prisma.emailSend.groupBy({ _count: true, by: ["promotionId"], where: { promotionId: { not: null }, state: "sent" } }),
    prisma.emailSend.groupBy({
      _count: true,
      by: ["promotionId"],
      where: { promotionId: { not: null }, state: { in: ["failed", "skipped"] } },
    }),
  ]);
  const countOf = (groups: { promotionId: string | null; _count: number }[]) =>
    new Map(groups.flatMap((g) => (g.promotionId ? [[g.promotionId, g._count] as const] : [])));
  const recipients = countOf(all);
  const sentBy = countOf(sent);
  const failedBy = countOf(failed);
  return rows.map((row) =>
    summarize(row, {
      recipients: recipients.get(row.id) ?? 0,
      sent: sentBy.get(row.id) ?? 0,
      failed: failedBy.get(row.id) ?? 0,
    }),
  );
}
