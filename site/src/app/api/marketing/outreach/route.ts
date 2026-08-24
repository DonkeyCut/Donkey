import { NextResponse } from "next/server";
import { z } from "zod";

import { creditMicrosToString } from "@/lib/credits/amounts";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import {
  CREDIT_SPENDERS_CAMPAIGN,
  OUTREACH_STATUSES,
} from "@/lib/marketing/campaigns";
import {
  OutreachNotSendableError,
  sendOutreachEmail,
} from "@/lib/marketing/send-outreach";
import { prisma } from "@/lib/prisma";

const listQuerySchema = z.object({
  status: z.enum(OUTREACH_STATUSES).default("todo"),
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
  ranOutAt: true,
  repliedAt: true,
  sentCount: true,
  spentMicros: true,
  status: true,
  user: { select: { createdAt: true, email: true, id: true, name: true } },
} as const;

type OutreachRow = {
  balanceMicros: bigint;
  firstSentAt: Date | null;
  id: string;
  lastActiveAt: Date | null;
  lastSentAt: Date | null;
  ranOutAt: Date | null;
  repliedAt: Date | null;
  sentCount: number;
  spentMicros: bigint;
  status: string;
  user: { createdAt: Date; email: string; id: string; name: string };
};

// Micros are BigInt and dates are Date; the client wants neither.
function serialize(row: OutreachRow) {
  return {
    balance: creditMicrosToString(row.balanceMicros),
    email: row.user.email,
    firstSentAt: row.firstSentAt?.toISOString() ?? null,
    id: row.id,
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    name: row.user.name,
    ranOutAt: row.ranOutAt?.toISOString() ?? null,
    repliedAt: row.repliedAt?.toISOString() ?? null,
    sentCount: row.sentCount,
    signedUpAt: row.user.createdAt.toISOString(),
    spent: creditMicrosToString(row.spentMicros),
    status: row.status,
    userId: row.user.id,
  };
}

// The list is whatever the nightly outreach-scan job wrote, so this reads one
// table and touches no credit data.
export const GET = withSuperUser(async (request) => {
  const parsed = listQuerySchema.safeParse({
    status: new URL(request.url).searchParams.get("status") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  // Each list is about a different moment: when they last used the product,
  // when the note went out, when they answered, when it was filed away.
  const orderBy = {
    ignored: { ignoredAt: "desc" },
    replied: { repliedAt: "desc" },
    sent: { lastSentAt: "desc" },
    todo: { lastActiveAt: "desc" },
  } as const;

  const rows = await prisma.userOutreach.findMany({
    orderBy: orderBy[parsed.data.status],
    select: rowSelect,
    take: 200,
    where: { campaign: CREDIT_SPENDERS_CAMPAIGN, status: parsed.data.status },
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
        user: outreach.user,
        vars: {
          balance: creditMicrosToString(outreach.balanceMicros),
          email: outreach.user.email,
          firstName: outreach.user.name.trim().split(/\s+/)[0] || outreach.user.name,
          name: outreach.user.name,
          spent: creditMicrosToString(outreach.spentMicros),
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
