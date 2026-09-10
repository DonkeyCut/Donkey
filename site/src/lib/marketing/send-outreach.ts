import { z } from "zod";

import { PermanentSendError } from "@/lib/email/errors";
import { emailFrom, type EmailMessage, type EmailUser } from "@/lib/email/resend";
import { isMarketingUnsubscribed, unsubscribePageUrl } from "@/lib/email/unsubscribe";
import { outreachReplyAddress } from "@/lib/marketing/replyAddress";
import { fillOutreachText, type OutreachVars, UnknownPlaceholderError } from "@/lib/marketing/placeholders";
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

// One person writing to one person, so the message goes out as text/plain with
// no markup, no template shell, and no bulk-mail headers. A mail provider reads
// an HTML body or a `List-Unsubscribe` header as a mailing list and files the
// note under promotions. When the operator turns the opt-out footer on, it
// rides along as a line of text.
function outreachText(body: string, unsubscribeUrl: string | null): string {
  const trimmed = body.trim();
  if (!unsubscribeUrl) return `${trimmed}\n`;
  return `${trimmed}\n\n--\nUnsubscribe from product emails: ${unsubscribeUrl}\n`;
}

// Builds one outreach note. The reply target is the operator's call per
// send: the row's own signed alias, or the sending address itself.
export async function buildOutreachEmail(payload: OutreachPayload, user: EmailUser): Promise<EmailMessage> {
  const from = emailFrom();
  if (!from) throw new PermanentSendError("RESEND_FROM_EMAIL is not configured.");
  if (await isMarketingUnsubscribed(user.id)) throw new PermanentSendError("That account is unsubscribed.");

  let subject: string;
  let body: string;
  try {
    subject = fillOutreachText(payload.subject, payload.vars);
    body = fillOutreachText(payload.body, payload.vars);
  } catch (error) {
    if (error instanceof UnknownPlaceholderError) throw new PermanentSendError(error.message);
    throw error;
  }
  return {
    from,
    to: user.email,
    replyTo: payload.trackReplies ? outreachReplyAddress(payload.outreachId) : undefined,
    subject,
    text: outreachText(body, payload.unsubscribeLink ? unsubscribePageUrl(user.id) : null),
  };
}

export async function recordOutreachSent(payload: OutreachPayload): Promise<void> {
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
