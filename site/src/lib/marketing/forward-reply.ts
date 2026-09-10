import { z } from "zod";

import { deliverEmail } from "@/lib/email/outbox";
import { emailFrom, getResend, isResendConfigured, type EmailMessage } from "@/lib/email/resend";
import { outreachIdFromRecipients } from "@/lib/marketing/replyAddress";
import { prisma } from "@/lib/prisma";

// Where a reply is forwarded so it can be answered from a normal inbox. Env
// rather than code for the same reason RESEND_FROM_EMAIL is: the open-source
// repo carries no personal address.
function outreachInbox(): string {
  return process.env.RESEND_INBOX_EMAIL ?? "";
}

// The banner names the account, and an account's display name is whatever
// Google handed us — it reaches the operator's inbox as markup otherwise.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type ReceivedEmail = {
  email_id: string;
  from: string;
  to: string[];
  received_for: string[];
  subject: string;
};

export const replyForwardPayloadSchema = z.object({ emailId: z.string().min(1), outreachId: z.string().min(1) }).strict();
export type ReplyForwardPayload = z.output<typeof replyForwardPayloadSchema>;

// Handles an inbound reply to a note that carried the signed reply alias —
// one sent with reply tracking on. Flips the row to replied and queues the
// forward so it can be answered from a normal inbox. The forward goes out as
// a fresh send rather than Resend's own forward call because only a send
// takes a reply-to — that is what makes hitting reply in the inbox address
// the user instead of looping back into the reply domain.
//
// Nothing about the message is written down beyond its id. Body, subject, and
// attachments travel from Resend through the builder to the inbox and stop
// there.
export async function forwardOutreachReply(email: ReceivedEmail): Promise<boolean> {
  const outreachId = outreachIdFromRecipients(email.received_for, email.to);
  if (!outreachId) return false;
  const outreach = await prisma.userOutreach.findUnique({
    select: { id: true, repliedAt: true },
    where: { id: outreachId },
  });
  if (!outreach) return false;

  // Keep the first reply's timestamp; a later one in the same thread only
  // confirms the status.
  await prisma.userOutreach.update({
    data: { repliedAt: outreach.repliedAt ?? new Date(), status: "replied" },
    where: { id: outreach.id },
  });

  if (!isResendConfigured() || !outreachInbox() || !emailFrom()) {
    console.warn("[outreach] reply not forwarded; inbox or sender unconfigured", { outreachId: outreach.id });
    return true;
  }
  await deliverEmail({
    // Resend's own dedupe is what keeps a redelivered webhook from forwarding
    // the same reply twice, and the outbox key mirrors it.
    idempotencyKey: `outreach-reply:${email.email_id}`,
    kind: "reply-forward",
    payload: { emailId: email.email_id, outreachId: outreach.id },
  });
  return true;
}

/** Fetches the reply from Resend and wraps it for the operator's inbox. */
export async function buildReplyForwardEmail(payload: ReplyForwardPayload): Promise<EmailMessage> {
  const inbox = outreachInbox();
  const from = emailFrom();
  if (!inbox || !from) throw new Error("RESEND_INBOX_EMAIL or RESEND_FROM_EMAIL is not configured.");
  const outreach = await prisma.userOutreach.findUnique({
    select: { user: { select: { email: true, name: true } } },
    where: { id: payload.outreachId },
  });
  if (!outreach) throw new Error("The outreach row no longer exists.");

  const resend = getResend();
  const received = await resend.emails.receiving.get(payload.emailId);
  if (received.error || !received.data) {
    throw new Error(`Resend inbound fetch failed: ${received.error?.name}: ${received.error?.message}`);
  }
  const attachments = await Promise.all(
    received.data.attachments.map(async (attachment) => {
      const file = await resend.emails.receiving.attachments.get({ emailId: payload.emailId, id: attachment.id });
      if (file.error || !file.data) {
        throw new Error(`Resend attachment fetch failed: ${file.error?.name}: ${file.error?.message}`);
      }
      return {
        contentType: file.data.content_type,
        filename: file.data.filename ?? attachment.filename ?? attachment.id,
        path: file.data.download_url,
      };
    }),
  );

  const banner = `${outreach.user.name} <${outreach.user.email}> replied to your outreach note.`;
  const bannerHtml = escapeHtml(banner);
  return {
    from,
    to: inbox,
    replyTo: outreach.user.email,
    subject: received.data.subject || "Re: What are you making?",
    attachments: attachments.length > 0 ? attachments : undefined,
    html: received.data.html ? `<p><strong>${bannerHtml}</strong></p>${received.data.html}` : undefined,
    text: received.data.text ? `${banner}\n\n${received.data.text}` : banner,
  };
}
