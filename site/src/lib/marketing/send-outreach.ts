import { z } from "zod";

import OutreachEmail from "@/emails/outreach";
import { createTermsCreditOffer } from "@/lib/credits/offers";
import { creditOfferTermsSchema } from "@/lib/credits/offerTerms";
import { PermanentSendError } from "@/lib/email/errors";
import { emailFrom, type EmailMessage, type EmailUser } from "@/lib/email/resend";
import { isMarketingUnsubscribed, unsubscribePageUrl } from "@/lib/email/unsubscribe";
import { outreachReplyAddress } from "@/lib/marketing/replyAddress";
import { type OutreachVars, UnknownPlaceholderError } from "@/lib/marketing/placeholders";
import { OutreachCopyError, renderOutreachCopy } from "@/lib/marketing/outreachCopy";
import { prisma } from "@/lib/prisma";

export const outreachPayloadSchema = z
  .object({
    outreachId: z.string().min(1),
    // Which send this is for the row, so a retried click cannot double-send
    // and a deliberate second note still goes out.
    attempt: z.number().int().min(1),
    actorUserId: z.string().min(1),
    // The final words, from a template or typed in the dialog. Placeholders
    // are filled at send time so the operator edits `{{firstName}}` and the
    // recipient reads their name.
    subject: z.string().min(1),
    body: z.string().min(1),
    vars: z
      .object({ balance: z.string(), email: z.string(), firstName: z.string(), name: z.string(), spent: z.string(), storage: z.string() })
      .strict() satisfies z.ZodType<OutreachVars>,
    // The credit offer the note carries, if any. The offer row is made when
    // the note is built, and the words fill in its link and last day.
    creditOffer: creditOfferTermsSchema.nullable().default(null),
    // Whether the note carries the opt-out footer. The operator decides per
    // send; the unsubscribed check always runs.
    unsubscribeLink: z.boolean(),
    // Whether replies route through the row's signed alias, which forwards
    // them to the operator's inbox and marks the row replied. Off puts the
    // sending address itself on the wire, so the note reads like any personal
    // thread and the row is filed with the list's "Mark replied" button.
    trackReplies: z.boolean(),
  })
  .strict();

export type OutreachPayload = z.output<typeof outreachPayloadSchema>;

export function outreachIdempotencyKey(outreachId: string, attempt: number): string {
  return `outreach:${outreachId}:${attempt}`;
}

// Every note carries a plain-text version, including its optional opt-out footer.
function outreachText(body: string, unsubscribeUrl: string | null): string {
  const trimmed = body.trim();
  if (!unsubscribeUrl) return `${trimmed}\n`;
  return `${trimmed}\n\n--\nUnsubscribe from product emails: ${unsubscribeUrl}\n`;
}

/** The scope of the offer one note makes: the row and the attempt, so a
 * deliberate second note makes a fresh offer and a retry reuses the first. */
export function outreachOfferScope(outreachId: string, attempt: number): string {
  return `outreach:${outreachId}:${attempt}`;
}

/** The scope of the offer a test note makes: the outbox row that carries it,
 * so every test mints the operator a fresh link. */
export function outreachTestOfferScope(outboxRowId: string): string {
  return `outreach-test:${outboxRowId}`;
}

// Builds one outreach note. The reply target is the operator's call per
// send: the row's own signed alias, or the sending address itself.
export async function buildOutreachEmail(
  payload: OutreachPayload,
  user: EmailUser,
  offerScope = outreachOfferScope(payload.outreachId, payload.attempt),
): Promise<EmailMessage | null> {
  if (await isMarketingUnsubscribed(user.id)) return null;
  const from = emailFrom();
  if (!from) throw new PermanentSendError("RESEND_FROM_EMAIL is not configured.");

  const offer = payload.creditOffer
    ? await createTermsCreditOffer({
        scope: offerScope,
        userId: user.id,
        terms: payload.creditOffer,
        offeredByUserId: payload.actorUserId,
      })
    : null;
  const vars: OutreachVars = { ...payload.vars, ...offer?.vars };
  let copy: ReturnType<typeof renderOutreachCopy>;
  try {
    copy = renderOutreachCopy(payload.subject, payload.body, vars, payload.creditOffer);
  } catch (error) {
    if (error instanceof UnknownPlaceholderError || error instanceof OutreachCopyError) throw new PermanentSendError(error.message);
    throw error;
  }
  const unsubscribeUrl = payload.unsubscribeLink ? unsubscribePageUrl(user.id) : null;
  return {
    from,
    to: user.email,
    replyTo: payload.trackReplies ? outreachReplyAddress(payload.outreachId) : undefined,
    subject: copy.subject,
    text: outreachText(copy.text, unsubscribeUrl),
    ...(copy.cta ? { react: OutreachEmail({ blocks: copy.blocks, cta: copy.cta, unsubscribeUrl }) } : {}),
  };
}

export async function recordOutreachSent(payload: Pick<OutreachPayload, "outreachId" | "actorUserId">): Promise<void> {
  const now = new Date();
  const row = await prisma.userOutreach.findUnique({ select: { firstSentAt: true }, where: { id: payload.outreachId } });
  if (!row) return;
  await prisma.userOutreach.update({
    data: {
      actorUserId: payload.actorUserId,
      firstSentAt: row.firstSentAt ?? now,
      lastSentAt: now,
      sentCount: { increment: 1 },
      status: "sent",
    },
    where: { id: payload.outreachId },
  });
}
