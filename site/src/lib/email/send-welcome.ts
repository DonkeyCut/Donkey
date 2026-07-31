import {
  DONKEY_LOGO_CID,
  DONKEY_LOGO_PNG_BASE64,
} from "@/emails/_components/logo";
import WelcomeEmail from "@/emails/welcome";
import {
  emailFrom,
  getResend,
  isResendConfigured,
  type EmailUser,
} from "@/lib/email/resend";
import {
  unsubscribeActionUrl,
  unsubscribePageUrl,
} from "@/lib/email/unsubscribe";
import { signupAppCredits } from "@/lib/onboarding/sequence";
import { prisma } from "@/lib/prisma";

// Sends the one-time welcome email. Two layers keep it single-send: the row
// claim below is the permanent record (only the caller whose conditional
// update flips the null actually sends), and Resend's idempotency key covers a
// crash between claim release and retry for 24 hours.
export async function sendWelcomeEmail(user: EmailUser): Promise<void> {
  if (!isResendConfigured()) {
    console.log("[email] RESEND_API_KEY not set; skipping welcome email", {
      userId: user.id,
    });
    return;
  }
  const from = emailFrom();
  if (!from) {
    console.log("[email] RESEND_FROM_EMAIL not set; skipping welcome email", {
      userId: user.id,
    });
    return;
  }

  await prisma.userEmailSettings.upsert({
    create: { userId: user.id },
    update: {},
    where: { userId: user.id },
  });
  const claim = await prisma.userEmailSettings.updateMany({
    data: { welcomeEmailSentAt: new Date() },
    where: { userId: user.id, welcomeEmailSentAt: null },
  });
  if (claim.count === 0) {
    return;
  }

  const firstName = user.name.trim().split(/\s+/)[0] || user.name;
  const { error } = await getResend().emails.send(
    {
      from,
      to: user.email,
      subject: "Thanks for signing up ❤️",
      react: WelcomeEmail({
        credits: signupAppCredits,
        logoSrc: `cid:${DONKEY_LOGO_CID}`,
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
    },
    { idempotencyKey: `welcome-email:${user.id}` },
  );
  if (error) {
    // Release the claim so the next provisioning run can retry; the
    // idempotency key keeps a near-simultaneous retry from double-sending.
    await prisma.userEmailSettings.updateMany({
      data: { welcomeEmailSentAt: null },
      where: { userId: user.id },
    });
    throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
  }
}
