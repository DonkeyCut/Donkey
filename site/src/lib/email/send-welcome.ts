import { DONKEY_LOGO_CID, DONKEY_LOGO_PNG_BASE64 } from "@/emails/_components/logo";
import WelcomeEmail from "@/emails/welcome";
import { bulkFrom, emailFrom, type EmailMessage, type EmailUser } from "@/lib/email/resend";
import { unsubscribeActionUrl, unsubscribePageUrl } from "@/lib/email/unsubscribe";
import { prisma } from "@/lib/prisma";

// The one-time welcome email. The outbox row keyed on the account is what
// keeps it single-send; the settings row records that it went.
// `credits` is the amount the signup grant landed, or null when the address
// had already received it on an earlier account; the email names it only
// when it is there.
export function welcomeIdempotencyKey(userId: string): string {
  return `welcome-email:${userId}`;
}

export function buildWelcomeEmail(user: EmailUser, credits: string | null): EmailMessage {
  const from = bulkFrom();
  if (!from) throw new Error("No bulk sender configured.");
  const firstName = user.name.trim().split(/\s+/)[0] || user.name;
  return {
    from,
    to: user.email,
    // The bulk subdomain sends but does not receive; a reply goes to the
    // apex address, where Google Workspace delivers it.
    replyTo: emailFrom() || from,
    subject: "Thanks for signing up ❤️",
    react: WelcomeEmail({
      credits,
      name: firstName,
      unsubscribeUrl: unsubscribePageUrl(user.id),
    }),
    // The mark rides inside the message (Content-ID embed) so no client
    // fetches anything external; Gmail strips data URIs, so cid is the only
    // fetch-free form that renders everywhere.
    attachments: [
      {
        content: DONKEY_LOGO_PNG_BASE64,
        contentId: DONKEY_LOGO_CID,
        contentType: "image/png",
        filename: "donkey-cut.png",
      },
    ],
    // RFC 8058 one-click: mail providers POST here with no session; the
    // signed token in the URL is the authorization.
    headers: {
      "List-Unsubscribe": `<${unsubscribeActionUrl(user.id)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

export async function recordWelcomeSent(userId: string): Promise<void> {
  await prisma.userEmailSettings.upsert({
    create: { userId, welcomeEmailSentAt: new Date() },
    update: { welcomeEmailSentAt: new Date() },
    where: { userId },
  });
}
