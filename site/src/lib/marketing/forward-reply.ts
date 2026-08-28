import { emailFrom, getResend, isResendConfigured } from "@/lib/email/resend";
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

// Handles an inbound reply to a note that carried the signed reply alias —
// one sent with reply tracking on. Flips the row to replied and
// forwards the message on so it can be answered from a normal inbox. The
// forward goes out as a fresh send rather than Resend's own forward call
// because only a send takes a reply-to — that is what makes hitting reply in
// the inbox address the user instead of looping back into the reply domain.
//
// Nothing about the message is written down. Body, subject, and attachments
// travel from Resend through this function to the inbox and stop there.
export async function forwardOutreachReply(email: ReceivedEmail): Promise<boolean> {
  const outreachId = outreachIdFromRecipients(email.received_for, email.to);
  if (!outreachId) {
    return false;
  }
  const outreach = await prisma.userOutreach.findUnique({
    select: { id: true, repliedAt: true, user: { select: { email: true, name: true } } },
    where: { id: outreachId },
  });
  if (!outreach) {
    return false;
  }

  // Keep the first reply's timestamp; a later one in the same thread only
  // confirms the status.
  await prisma.userOutreach.update({
    data: { repliedAt: outreach.repliedAt ?? new Date(), status: "replied" },
    where: { id: outreach.id },
  });

  const inbox = outreachInbox();
  const from = emailFrom();
  if (!isResendConfigured() || !inbox || !from) {
    console.warn("[outreach] reply not forwarded; inbox or sender unconfigured", {
      outreachId: outreach.id,
    });
    return true;
  }

  const resend = getResend();
  const received = await resend.emails.receiving.get(email.email_id);
  if (received.error || !received.data) {
    throw new Error(
      `Resend inbound fetch failed: ${received.error?.name}: ${received.error?.message}`,
    );
  }

  const attachments = await Promise.all(
    received.data.attachments.map(async (attachment) => {
      const file = await resend.emails.receiving.attachments.get({
        emailId: email.email_id,
        id: attachment.id,
      });
      if (file.error || !file.data) {
        throw new Error(
          `Resend attachment fetch failed: ${file.error?.name}: ${file.error?.message}`,
        );
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
  const { error } = await resend.emails.send(
    {
      from,
      to: inbox,
      replyTo: outreach.user.email,
      subject: received.data.subject || "Re: What are you making?",
      attachments: attachments.length > 0 ? attachments : undefined,
      html: received.data.html
        ? `<p><strong>${bannerHtml}</strong></p>${received.data.html}`
        : undefined,
      text: received.data.text ? `${banner}\n\n${received.data.text}` : banner,
    },
    // Resend's own dedupe is what keeps a redelivered webhook from forwarding
    // the same reply twice, so nothing has to be written down to track it.
    { idempotencyKey: `outreach-reply:${email.email_id}` },
  );
  if (error) {
    throw new Error(`Resend forward failed: ${error.name}: ${error.message}`);
  }
  return true;
}
