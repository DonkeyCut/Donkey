import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import {
  DONKEY_LOGO_CID,
  DONKEY_LOGO_PNG_BASE64,
} from "@/emails/_components/logo";
import CreditsExpiringEmail from "@/emails/credits-expiring";
import { formatUsd } from "@/lib/credits/format-usd";
import { formatCreditExpiry } from "@/lib/credits/top-up";
import {
  bulkFrom,
  emailFrom,
  getResend,
  isResendConfigured,
  ResendNotConfiguredError,
  type EmailUser,
} from "@/lib/email/resend";
import {
  unsubscribeActionUrl,
  unsubscribePageUrl,
} from "@/lib/email/unsubscribe";

// Tells one account what is left of its signup credits and the day they
// expire. `credits` is the remaining amount as a decimal string. The caller
// decides who gets it and records that it went; here the idempotency key keeps
// a retry within 24 hours from sending twice.
export async function sendCreditsExpiringEmail(
  user: EmailUser,
  credits: string,
  expiresAt: Date,
  idempotencyKey = `credits-expiring:${user.id}:${expiresAt.toISOString().slice(0, 10)}`,
): Promise<void> {
  if (!isResendConfigured()) throw new ResendNotConfiguredError();
  const from = bulkFrom();
  if (!from) throw new Error("No bulk sender configured.");

  const firstName = user.name.trim().split(/\s+/)[0] || user.name;
  const { error } = await getResend().emails.send(
    {
      from,
      to: user.email,
      replyTo: emailFrom() || from,
      subject: `Your ${formatUsd(credits)} in AI credits expires ${formatCreditExpiry(expiresAt)}`,
      react: CreditsExpiringEmail({
        credits: formatUsd(credits),
        editorUrl: `${DONKEYCUT_CANONICAL}/app`,
        expiresOn: formatCreditExpiry(expiresAt),
        name: firstName,
        unsubscribeUrl: unsubscribePageUrl(user.id),
      }),
      attachments: [
        {
          content: DONKEY_LOGO_PNG_BASE64,
          contentId: DONKEY_LOGO_CID,
          contentType: "image/png",
          filename: "donkey-cut.png",
        },
      ],
      headers: {
        "List-Unsubscribe": `<${unsubscribeActionUrl(user.id)}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    },
    { idempotencyKey },
  );
  if (error) {
    throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
  }
}
