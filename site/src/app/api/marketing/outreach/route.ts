import { NextResponse } from "next/server";
import { z } from "zod";

import { formatBytes } from "@/lib/bytes";
import { creditMicrosToString } from "@/lib/credits/amounts";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import {
  CREDIT_SPENDERS_CAMPAIGN,
  OUTREACH_REASONS,
  OUTREACH_STATUSES,
} from "@/lib/marketing/campaigns";
import {
  OutreachNotSendableError,
  sendOutreachEmail,
} from "@/lib/marketing/send-outreach";
import { prisma } from "@/lib/prisma";

const listQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  reason: z.enum(OUTREACH_REASONS).optional(),
  status: z.enum(OUTREACH_STATUSES).optional(),
});

// Two shapes: start a conversation with a user who is on the list, or file a
// row that is already on it.
const actionSchema = z.union([
  z
    .object({
      action: z.literal("send"),
      body: z.string().trim().min(1).max(5000),
      outreachId: z.string().trim().min(1),
      subject: z.string().trim().min(1).max(200),
      trackReplies: z.boolean(),
      unsubscribeLink: z.boolean(),
    })
    .strict(),
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

  const outreach = await prisma.userOutreach.findUnique({
    select: rowSelect,
    where: { id: parsed.data.outreachId },
  });
  if (!outreach) {
    return notFoundResponse();
  }

  const now = new Date();
  const actorUserId = request.donkey.userId;

  if (parsed.data.action === "send") {
    try {
      await sendOutreachEmail({
        attempt: outreach.sentCount + 1,
        body: parsed.data.body,
        outreachId: outreach.id,
        subject: parsed.data.subject,
        trackReplies: parsed.data.trackReplies,
        unsubscribeLink: parsed.data.unsubscribeLink,
        user: outreach.user,
        vars: {
          balance: creditMicrosToString(outreach.balanceMicros),
          email: outreach.user.email,
          firstName: outreach.user.name.trim().split(/\s+/)[0] || outreach.user.name,
          name: outreach.user.name,
          spent: creditMicrosToString(outreach.spentMicros),
          storage: formatBytes(Number(outreach.storageBytes)),
        },
      });
    } catch (error) {
      if (error instanceof OutreachNotSendableError) {
        return NextResponse.json(
          { error: "not_sendable", message: error.message },
          { status: 409 },
        );
      }
      throw error;
    }
    const row = await prisma.userOutreach.update({
      data: {
        actorUserId,
        firstSentAt: outreach.firstSentAt ?? now,
        lastSentAt: now,
        sentCount: { increment: 1 },
        status: "sent",
      },
      select: rowSelect,
      where: { id: outreach.id },
    });
    return NextResponse.json({ row: serialize(row) });
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
