import type { Prisma } from "@/generated/prisma/client";
import { getGlobalSetting } from "@/lib/config/effective";
import {
  DailyEmailSendLimitError,
  dailyEmailQuotaStatus,
  type DailyEmailQuotaStatus,
  type EmailSendKind,
  withDailyEmailQuota,
} from "@/lib/email/daily-send-limit";
import { PermanentSendError } from "@/lib/email/errors";
import { EMAIL_KIND_IDS, type EmailKindId } from "@/lib/email/kindIds";
import { EMAIL_KINDS, type OutboxRow } from "@/lib/email/kinds";
import { getResend, isResendConfigured, ResendNotConfiguredError } from "@/lib/email/resend";
import { UnknownPlaceholderError } from "@/lib/marketing/placeholders";
import { prisma } from "@/lib/prisma";

// The outbox. Every email is queued as a row and sent by the drainer in
// priority order, each row under its kind's share of the day's quota. An
// interactive send (an operator's note, a signup's welcome) is queued and
// tried at once; when the quota refuses it, it waits its turn. The row is
// the record: what went, what failed and why, and what is still owed.

const PAGE = 50;
// Provider rate limit: two requests a second.
const PACE_MS = 550;
const MAX_ATTEMPTS = 5;
// A row claimed this long ago and never settled is a killed drainer's.
const STALE_SENDING_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type QueueEmailInput = {
  kind: EmailKindId;
  payload: Prisma.InputJsonValue;
  idempotencyKey: string;
  userId?: string;
  promotionId?: string;
  rank?: number;
};

export type DeliverResult = { id: string; state: "sent" | "queued" | "failed" | "skipped"; error: string | null };

type Outcome =
  | { outcome: "sent" | "retried" | "failed" | "skipped" | "busy" }
  | { outcome: "refused"; retryAfterSeconds: number };

function claimable(now: Date): Prisma.EmailSendWhereInput {
  return {
    OR: [{ state: "queued" }, { state: "sending", updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } }],
  };
}

function isPermanent(error: unknown): boolean {
  return (
    error instanceof PermanentSendError ||
    error instanceof UnknownPlaceholderError ||
    error instanceof ResendNotConfiguredError
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rowsOf(inputs: QueueEmailInput[]) {
  const priorities = await getGlobalSetting("emailPriorities");
  return inputs.map((input) => ({
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    payload: input.payload,
    priority: priorities[input.kind],
    promotionId: input.promotionId,
    rank: input.rank ?? 0,
    userId: input.userId,
  }));
}

/** Queues many emails at once; rows already queued under the same key are
 * left as they are. Returns how many were new. */
export async function queueEmails(inputs: QueueEmailInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  const { count } = await prisma.emailSend.createMany({ data: await rowsOf(inputs), skipDuplicates: true });
  if (count > 0) await scheduleDrain(0);
  return count;
}

/** Queues one email and tries to send it now. When the quota refuses it, the
 * row waits for the drainer; a permanent failure is reported on the result. */
export async function deliverEmail(input: QueueEmailInput): Promise<DeliverResult> {
  const [data] = await rowsOf([input]);
  await prisma.emailSend.createMany({ data: [data], skipDuplicates: true });
  const row = await prisma.emailSend.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
  if (row.state === "queued") {
    const outcome = await sendRow(row, new Date());
    if (outcome.outcome === "refused") await scheduleDrain(outcome.retryAfterSeconds);
  }
  const settled = await prisma.emailSend.findUniqueOrThrow({ select: { error: true, id: true, state: true }, where: { id: row.id } });
  const state = settled.state === "sending" ? "queued" : (settled.state as DeliverResult["state"]);
  return { error: settled.error, id: settled.id, state };
}

/** Makes sure a drainer is coming, no sooner than the delay. One pending
 * drain job serves every caller. */
export async function scheduleDrain(delaySeconds: number): Promise<void> {
  const pending = await prisma.asyncJob.findFirst({
    select: { id: true },
    where: { kind: "email-drain", state: { in: ["queued", "running"] } },
  });
  if (pending) return;
  // Imported here because the job registry imports this module.
  const { enqueueJob } = await import("@/lib/jobs/queue");
  await enqueueJob("email-drain", {}, "system", { delaySeconds });
}

type DrainableRow = Awaited<ReturnType<typeof prisma.emailSend.findMany>>[number];

async function sendRow(row: DrainableRow, now: Date): Promise<Outcome> {
  const claimed = await prisma.emailSend.updateMany({
    data: { state: "sending" },
    where: { id: row.id, ...claimable(now) },
  });
  if (claimed.count === 0) return { outcome: "busy" };

  const outboxRow: OutboxRow = { id: row.id, idempotencyKey: row.idempotencyKey, promotionId: row.promotionId, userId: row.userId };
  const kind = EMAIL_KINDS[row.kind as EmailKindId];
  const attempts = row.attempts + 1;
  const settle = (data: Prisma.EmailSendUpdateInput) => prisma.emailSend.update({ data, where: { id: row.id } });

  const giveUp = async (error: unknown, payload: unknown) => {
    await settle({ attempts, error: messageOf(error), state: "failed" });
    if (kind && payload !== undefined) await kind.onAbandon?.(payload, outboxRow, error instanceof Error ? error : new Error(messageOf(error)));
    return { outcome: "failed" } as const;
  };

  if (!kind) return giveUp(new PermanentSendError(`Unknown email kind "${row.kind}".`), undefined);
  const parsed = kind.payload.safeParse(row.payload);
  if (!parsed.success) return giveUp(new PermanentSendError("The stored payload is invalid."), undefined);
  const payload = parsed.data;

  try {
    if (!isResendConfigured()) throw new ResendNotConfiguredError();
    const message = await kind.build(payload, outboxRow);
    if (!message) {
      await settle({ attempts, error: null, state: "skipped" });
      return { outcome: "skipped" };
    }
    const result = await withDailyEmailQuota(kind.quota, () =>
      getResend().emails.send(message, { idempotencyKey: row.idempotencyKey }),
    );
    if (result.error) throw new Error(`Resend send failed: ${result.error.name}: ${result.error.message}`);
    await settle({ attempts, error: null, sentAt: new Date(), state: "sent" });
    await kind.afterSend?.(payload, outboxRow);
    return { outcome: "sent" };
  } catch (error) {
    if (error instanceof DailyEmailSendLimitError) {
      await settle({ state: "queued" });
      return { outcome: "refused", retryAfterSeconds: error.retryAfterSeconds };
    }
    if (isPermanent(error) || attempts >= MAX_ATTEMPTS) return giveUp(error, payload);
    // A provider blip: back off, further each time, so a bad hour does not
    // burn the row's attempts.
    await settle({
      attempts,
      error: messageOf(error),
      notBefore: new Date(now.getTime() + attempts * 5 * 60_000),
      state: "queued",
    });
    return { outcome: "retried" };
  }
}

export type DrainResult = {
  sent: number;
  failed: number;
  skipped: number;
  retried: number;
  // Seconds until a refused quota is expected to open; null when nothing was refused.
  retryAfterSeconds: number | null;
  // Whether the budget ran out with rows still owed.
  more: boolean;
};

/** Sends what the outbox holds, highest priority first, until the budget or
 * the quota runs out. A refused quota class is left alone for the rest of
 * the run; the classes above it keep going. */
export async function drainOutbox(budgetMs: number): Promise<DrainResult> {
  const startedAt = Date.now();
  const result: DrainResult = { sent: 0, failed: 0, skipped: 0, retried: 0, retryAfterSeconds: null, more: false };
  const refused = new Map<EmailSendKind, number>();
  const touchedPromotions = new Set<string>();

  const refusedKinds = () =>
    (Object.keys(EMAIL_KINDS) as EmailKindId[]).filter((id) => refused.has(EMAIL_KINDS[id].quota));

  drain: for (;;) {
    const now = new Date();
    const rows = await prisma.emailSend.findMany({
      orderBy: [{ priority: "desc" }, { rank: "asc" }, { createdAt: "asc" }],
      take: PAGE,
      where: {
        AND: [
          claimable(now),
          { kind: { notIn: refusedKinds() }, notBefore: { lte: now } },
          // A paused promotion's rows wait where they are.
          { OR: [{ promotionId: null }, { promotion: { status: "sending" } }] },
        ],
      },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (Date.now() - startedAt > budgetMs) {
        result.more = true;
        break drain;
      }
      const quota = EMAIL_KINDS[row.kind as EmailKindId]?.quota;
      if (quota && refused.has(quota)) continue;
      const outcome = await sendRow(row, new Date());
      if (row.promotionId) touchedPromotions.add(row.promotionId);
      if (outcome.outcome === "refused") {
        if (quota) refused.set(quota, outcome.retryAfterSeconds);
        continue;
      }
      if (outcome.outcome !== "busy") result[outcome.outcome]++;
      if (outcome.outcome === "sent") await sleep(PACE_MS);
    }
  }

  await finishPromotions(touchedPromotions);
  if (refused.size > 0) result.retryAfterSeconds = Math.min(...refused.values());
  return result;
}

// A promotion with nothing left to send is sent.
async function finishPromotions(promotionIds: Set<string>): Promise<void> {
  for (const promotionId of promotionIds) {
    const owed = await prisma.emailSend.count({ where: { promotionId, state: { in: ["queued", "sending"] } } });
    if (owed > 0) continue;
    await prisma.promotion.updateMany({
      data: { finishedAt: new Date(), status: "sent" },
      where: { id: promotionId, status: "sending" },
    });
  }
}

export type OutboxKindRow = {
  kind: EmailKindId;
  priority: number;
  quota: EmailSendKind;
  queued: number;
  sentToday: number;
  failed: number;
};

export type OutboxItem = {
  id: string;
  kind: string;
  state: string;
  priority: number;
  rank: number;
  email: string | null;
  promotionName: string | null;
  attempts: number;
  error: string | null;
  notBefore: string;
  // Whether a failed attempt is holding the row back right now.
  backingOff: boolean;
  sentAt: string | null;
  createdAt: string;
};

export type OutboxOverview = {
  quota: DailyEmailQuotaStatus;
  kinds: OutboxKindRow[];
  // What is waiting, then what failed, then what went most recently.
  items: OutboxItem[];
  drainPending: boolean;
};

const ITEMS = 60;

/** The outbox as su sees it: the day's quota, every kind's standing, and the
 * rows worth a look. */
export async function outboxOverview(now = new Date()): Promise<OutboxOverview> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [quota, priorities, queued, sentToday, failed, waiting, broken, recent, drain] = await Promise.all([
    dailyEmailQuotaStatus(now),
    getGlobalSetting("emailPriorities"),
    prisma.emailSend.groupBy({ _count: true, by: ["kind"], where: { state: { in: ["queued", "sending"] } } }),
    prisma.emailSend.groupBy({ _count: true, by: ["kind"], where: { sentAt: { gte: dayStart }, state: "sent" } }),
    prisma.emailSend.groupBy({ _count: true, by: ["kind"], where: { state: "failed" } }),
    prisma.emailSend.findMany({
      include: { promotion: { select: { name: true } }, user: { select: { email: true } } },
      orderBy: [{ priority: "desc" }, { rank: "asc" }, { createdAt: "asc" }],
      take: ITEMS,
      where: { state: { in: ["queued", "sending"] } },
    }),
    prisma.emailSend.findMany({
      include: { promotion: { select: { name: true } }, user: { select: { email: true } } },
      orderBy: { updatedAt: "desc" },
      take: ITEMS,
      where: { state: "failed" },
    }),
    prisma.emailSend.findMany({
      include: { promotion: { select: { name: true } }, user: { select: { email: true } } },
      orderBy: { sentAt: "desc" },
      take: ITEMS,
      where: { state: { in: ["sent", "skipped"] } },
    }),
    prisma.asyncJob.findFirst({ select: { id: true }, where: { kind: "email-drain", state: { in: ["queued", "running"] } } }),
  ]);
  const countOf = (groups: { kind: string; _count: number }[], kind: string) =>
    groups.find((g) => g.kind === kind)?._count ?? 0;
  const kinds = EMAIL_KIND_IDS.map((kind) => ({
    kind,
    priority: priorities[kind],
    quota: EMAIL_KINDS[kind].quota,
    queued: countOf(queued, kind),
    sentToday: countOf(sentToday, kind),
    failed: countOf(failed, kind),
  }));
  const items = [...waiting, ...broken, ...recent].map((row) => ({
    id: row.id,
    kind: row.kind,
    state: row.state,
    priority: row.priority,
    rank: row.rank,
    email: row.user?.email ?? null,
    promotionName: row.promotion?.name ?? null,
    attempts: row.attempts,
    error: row.error,
    notBefore: row.notBefore.toISOString(),
    backingOff: row.state === "queued" && row.notBefore.getTime() > now.getTime(),
    sentAt: row.sentAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
  return { quota, kinds, items, drainPending: drain !== null };
}

/** Puts a failed row back in the queue with a clean slate and sends for a
 * drainer. */
export async function retryEmail(id: string): Promise<boolean> {
  const { count } = await prisma.emailSend.updateMany({
    data: { attempts: 0, error: null, notBefore: new Date(), state: "queued" },
    where: { id, state: "failed" },
  });
  if (count > 0) await scheduleDrain(0);
  return count > 0;
}
