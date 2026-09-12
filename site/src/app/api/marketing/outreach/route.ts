import { NextResponse } from "next/server";
import { z } from "zod";

import { formatBytes } from "@/lib/bytes";
import { creditMicrosToString, zeroCreditMicros } from "@/lib/credits/amounts";
import { CLAIM_URL_PLACEHOLDER, creditOfferTermsSchema } from "@/lib/credits/offerTerms";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import {
  CREDIT_SPENDERS_CAMPAIGN,
  OUTREACH_REASONS,
  OUTREACH_STATUSES,
  PICKED_REASON,
} from "@/lib/marketing/campaigns";
import { deliverEmail } from "@/lib/email/outbox";
import { lastActiveByUser } from "@/lib/marketing/lastActive";
import {
  fillOutreachText,
  firstNameOf,
  isOfferPlaceholder,
  UnknownPlaceholderError,
  type OutreachVars,
} from "@/lib/marketing/placeholders";
import { promotionIdempotencyKey } from "@/lib/marketing/promotions";
import { sendIssue } from "@/lib/marketing/promotionSave";
import { outreachIdempotencyKey } from "@/lib/marketing/send-outreach";
import { prisma } from "@/lib/prisma";

const listQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  reason: z.enum(OUTREACH_REASONS).optional(),
  status: z.enum(OUTREACH_STATUSES).optional(),
});

const noteSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  outreachId: z.string().trim().min(1),
  subject: z.string().trim().min(1).max(200),
  unsubscribeLink: z.boolean(),
  creditOffer: creditOfferTermsSchema.nullable().default(null),
});

// Five shapes: start a conversation with a user who is on the list, mail
// the note to yourself first, send them a promotion as it stands, file a row
// that is already on it, or put an account on the list by its address.
const actionSchema = z.union([
  z
    .object({
      action: z.literal("promote"),
      outreachId: z.string().trim().min(1),
      promotionId: z.string().trim().min(1),
    })
    .strict(),
  noteSchema.extend({ action: z.literal("send"), trackReplies: z.boolean() }).strict(),
  noteSchema.extend({ action: z.literal("test") }).strict(),
  z.object({ action: z.literal("add"), email: z.string().trim().min(1).max(320) }).strict(),
  z
    .object({
      action: z.enum(["ignore", "unignore", "replied"]),
      outreachId: z.string().trim().min(1),
    })
    .strict(),
]);

const rowSelect = {
  balanceMicros: true,
  firstSentAt: true,
  id: true,
  lastActiveAt: true,
  lastSentAt: true,
  paymentFailedAt: true,
  ranOutAt: true,
  reasons: true,
  repliedAt: true,
  sentCount: true,
  spentMicros: true,
  status: true,
  storageBytes: true,
  user: { select: { createdAt: true, email: true, id: true, name: true } },
} as const;

type OutreachRow = {
  balanceMicros: bigint;
  firstSentAt: Date | null;
  id: string;
  lastActiveAt: Date | null;
  lastSentAt: Date | null;
  paymentFailedAt: Date | null;
  ranOutAt: Date | null;
  reasons: string[];
  repliedAt: Date | null;
  sentCount: number;
  spentMicros: bigint;
  status: string;
  storageBytes: bigint;
  user: { createdAt: Date; email: string; id: string; name: string };
};

// Micros and byte counts are BigInt and dates are Date; the client wants
// neither.
function serialize(row: OutreachRow) {
  return {
    balance: creditMicrosToString(row.balanceMicros),
    email: row.user.email,
    firstSentAt: row.firstSentAt?.toISOString() ?? null,
    id: row.id,
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    name: row.user.name,
    paymentFailedAt: row.paymentFailedAt?.toISOString() ?? null,
    ranOutAt: row.ranOutAt?.toISOString() ?? null,
    reasons: row.reasons,
    repliedAt: row.repliedAt?.toISOString() ?? null,
    sentCount: row.sentCount,
    signedUpAt: row.user.createdAt.toISOString(),
    spent: creditMicrosToString(row.spentMicros),
    status: row.status,
    storageBytes: row.storageBytes.toString(),
    userId: row.user.id,
  };
}

// The list is whatever the nightly outreach-scan job wrote, so this reads one
// table and touches no credit data.
export const GET = withSuperUser(async (request) => {
  const params = new URL(request.url).searchParams;
  const parsed = listQuerySchema.safeParse({
    q: params.get("q") ?? undefined,
    reason: params.get("reason") ?? undefined,
    status: params.get("status") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }

  // A search matches name and email in the database, so an account buried
  // past the page cap is still found. The counts say how many matches every
  // status holds; the rows are the first page of them, one status when the
  // client pins a tab.
  if (parsed.data.q !== undefined) {
    const matching = {
      campaign: CREDIT_SPENDERS_CAMPAIGN,
      user: {
        OR: [
          { email: { contains: parsed.data.q, mode: "insensitive" as const } },
          { name: { contains: parsed.data.q, mode: "insensitive" as const } },
        ],
      },
    };
    const [rows, grouped] = await Promise.all([
      prisma.userOutreach.findMany({
        orderBy: { lastActiveAt: { nulls: "last", sort: "desc" } },
        select: rowSelect,
        take: 200,
        where: parsed.data.status
          ? { ...matching, status: parsed.data.status }
          : matching,
      }),
      prisma.userOutreach.groupBy({
        _count: true,
        by: ["status"],
        where: matching,
      }),
    ]);
    const counts = Object.fromEntries(
      OUTREACH_STATUSES.map((status) => [status, 0]),
    ) as Record<(typeof OUTREACH_STATUSES)[number], number>;
    for (const group of grouped) {
      if (group.status in counts) {
        counts[group.status as keyof typeof counts] = group._count;
      }
    }
    return NextResponse.json({ counts, rows: rows.map(serialize) });
  }

  // Each list is about a different moment: when they last used the product,
  // when the note went out, when they answered, when it was filed away.
  const orderBy = {
    ignored: { ignoredAt: "desc" },
    replied: { repliedAt: "desc" },
    sent: { lastSentAt: "desc" },
    todo: { lastActiveAt: "desc" },
  } as const;
  const status = parsed.data.status ?? "todo";

  // A reason narrows the list to the accounts the scan listed for it.
  const rows = await prisma.userOutreach.findMany({
    orderBy: orderBy[status],
    select: rowSelect,
    take: 200,
    where: {
      campaign: CREDIT_SPENDERS_CAMPAIGN,
      status,
      ...(parsed.data.reason ? { reasons: { has: parsed.data.reason } } : {}),
    },
  });

  return NextResponse.json({ rows: rows.map(serialize) });
});

// The words are filled once here with the row's own values, so a typo in a
// placeholder, or an offer placeholder in a note that carries no offer, is
// refused before anything is queued; so is an offer the words never link to,
// since the link is the only way the person reaches it.
function wordsIssue(subject: string, body: string, vars: OutreachVars, offered: boolean): string | null {
  if (offered && !subject.includes(CLAIM_URL_PLACEHOLDER) && !body.includes(CLAIM_URL_PLACEHOLDER)) {
    return `A note with a credit offer needs ${CLAIM_URL_PLACEHOLDER} in it.`;
  }
  try {
    fillOutreachText(subject, vars);
    fillOutreachText(body, vars);
    return null;
  } catch (error) {
    if (!(error instanceof UnknownPlaceholderError)) throw error;
    return isOfferPlaceholder(error.placeholder)
      ? `Turn on the credit offer to use {{${error.placeholder}}}.`
      : error.message;
  }
}

/** Puts an account on the list by hand, with the numbers the list shows read
 * now. An account already on it comes back as it is, whatever its status. */
async function addByEmail(email: string) {
  const user = await prisma.user.findFirst({
    select: { id: true },
    where: { email: { equals: email, mode: "insensitive" } },
  });
  if (!user) return null;
  const [account, storage, lastActiveBy] = await Promise.all([
    prisma.userCreditAccount.findUnique({
      select: { balanceMicros: true, lifetimeChargedMicros: true },
      where: { userId: user.id },
    }),
    prisma.cutStorageUsage.findUnique({ select: { bytes: true }, where: { userId: user.id } }),
    lastActiveByUser([user.id]),
  ]);
  return prisma.userOutreach.upsert({
    create: {
      balanceMicros: account?.balanceMicros ?? zeroCreditMicros,
      campaign: CREDIT_SPENDERS_CAMPAIGN,
      lastActiveAt: lastActiveBy.get(user.id) ?? null,
      reasons: [PICKED_REASON],
      spentMicros: account?.lifetimeChargedMicros ?? zeroCreditMicros,
      status: "todo",
      storageBytes: storage?.bytes ?? BigInt(0),
      userId: user.id,
    },
    select: rowSelect,
    update: {},
    where: { userId_campaign: { campaign: CREDIT_SPENDERS_CAMPAIGN, userId: user.id } },
  });
}

export const POST = withSuperUser(async (request) => {
  const parsed = actionSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request",
        issues: parsed.error.issues.map((issue) => ({
          message: issue.message,
          path: issue.path.join("."),
        })),
      },
      { status: 400 },
    );
  }

  if (parsed.data.action === "add") {
    const row = await addByEmail(parsed.data.email);
    if (!row) return notFoundResponse();
    return NextResponse.json({ row: serialize(row) });
  }

  const outreach = await prisma.userOutreach.findUnique({
    select: rowSelect,
    where: { id: parsed.data.outreachId },
  });
  if (!outreach) {
    return notFoundResponse();
  }

  const now = new Date();
  const actorUserId = request.donkey.userId;

  if (parsed.data.action === "send" || parsed.data.action === "test") {
    const attempt = outreach.sentCount + 1;
    const vars = {
      balance: creditMicrosToString(outreach.balanceMicros),
      email: outreach.user.email,
      firstName: firstNameOf(outreach.user.name),
      name: outreach.user.name,
      spent: creditMicrosToString(outreach.spentMicros),
      storage: formatBytes(Number(outreach.storageBytes)),
    };
    const issue = wordsIssue(
      parsed.data.subject,
      parsed.data.body,
      parsed.data.creditOffer ? { ...vars, claimUrl: "", claimBy: "" } : vars,
      parsed.data.creditOffer !== null,
    );
    if (issue) {
      return NextResponse.json({ error: "Invalid request", issues: [{ message: issue, path: "body" }] }, { status: 400 });
    }
    // A test goes to the operator with the row's values filled in, so the
    // note reads as the person would read it; the row is left as it is.
    if (parsed.data.action === "test") {
      const operator = await prisma.user.findUnique({ select: { email: true }, where: { id: actorUserId } });
      if (!operator) return notFoundResponse();
      const delivery = await deliverEmail({
        idempotencyKey: `outreach-test:${outreach.id}:${Date.now()}`,
        kind: "outreach-test",
        payload: {
          actorUserId,
          attempt,
          body: parsed.data.body,
          creditOffer: parsed.data.creditOffer,
          outreachId: outreach.id,
          subject: parsed.data.subject,
          trackReplies: false,
          unsubscribeLink: parsed.data.unsubscribeLink,
          vars,
        },
        userId: actorUserId,
      });
      if (delivery.state === "failed") {
        return NextResponse.json({ error: "not_sendable", message: delivery.error }, { status: 409 });
      }
      return NextResponse.json({ delivery: delivery.state, row: serialize(outreach), sentTo: operator.email });
    }
    const delivery = await deliverEmail({
      idempotencyKey: outreachIdempotencyKey(outreach.id, attempt),
      kind: "outreach",
      payload: {
        actorUserId,
        attempt,
        body: parsed.data.body,
        creditOffer: parsed.data.creditOffer,
        outreachId: outreach.id,
        subject: parsed.data.subject,
        trackReplies: parsed.data.trackReplies,
        unsubscribeLink: parsed.data.unsubscribeLink,
        vars,
      },
      userId: outreach.user.id,
    });
    if (delivery.state === "failed") {
      return NextResponse.json({ error: "not_sendable", message: delivery.error }, { status: 409 });
    }
    const row = await prisma.userOutreach.findUniqueOrThrow({ select: rowSelect, where: { id: outreach.id } });
    return NextResponse.json({ delivery: delivery.state, row: serialize(row) });
  }

  // The promotion goes out as the segment send would send it, under the same
  // per-person key, so it counts in the promotion and a later segment send
  // skips this person. Someone it already reached is refused, since the key
  // stands for the mail that went.
  if (parsed.data.action === "promote") {
    const promotion = await prisma.promotion.findUnique({ where: { id: parsed.data.promotionId } });
    if (!promotion) return notFoundResponse();
    const refused = sendIssue(promotion);
    if (refused) return refused;
    const idempotencyKey = promotionIdempotencyKey(promotion.id, outreach.user.id);
    const earlier = await prisma.emailSend.findUnique({ select: { state: true }, where: { idempotencyKey } });
    if (earlier && earlier.state !== "failed") {
      const message =
        earlier.state === "sent" ? "They already received this promotion." : "This promotion is already on its way to them.";
      return NextResponse.json({ error: "Invalid request", issues: [{ message, path: "promotion" }] }, { status: 400 });
    }
    if (earlier) await prisma.emailSend.delete({ where: { idempotencyKey } });
    const delivery = await deliverEmail({
      idempotencyKey,
      kind: "promotion-hand",
      payload: { actorUserId, outreachId: outreach.id, promotionId: promotion.id },
      promotionId: promotion.id,
      userId: outreach.user.id,
    });
    if (delivery.state === "failed") {
      return NextResponse.json({ error: "not_sendable", message: delivery.error }, { status: 409 });
    }
    const row = await prisma.userOutreach.findUniqueOrThrow({ select: rowSelect, where: { id: outreach.id } });
    return NextResponse.json({ delivery: delivery.state, row: serialize(row) });
  }

  const data =
    parsed.data.action === "ignore"
      ? { actorUserId, ignoredAt: now, status: "ignored" }
      : parsed.data.action === "unignore"
        ? { actorUserId, ignoredAt: null, status: "todo" }
        : { actorUserId, repliedAt: outreach.repliedAt ?? now, status: "replied" };

  const row = await prisma.userOutreach.update({
    data,
    select: rowSelect,
    where: { id: outreach.id },
  });
  return NextResponse.json({ row: serialize(row) });
});
