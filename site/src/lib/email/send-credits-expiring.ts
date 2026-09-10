import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { DONKEY_LOGO_CID, DONKEY_LOGO_PNG_BASE64 } from "@/emails/_components/logo";
import CreditsExpiringEmail from "@/emails/credits-expiring";
import { formatUsdPlain } from "@/lib/credits/format-usd";
import { formatCreditExpiry } from "@/lib/credits/top-up";
import { bulkFrom, emailFrom, type EmailMessage, type EmailUser } from "@/lib/email/resend";
import { unsubscribeActionUrl, unsubscribePageUrl } from "@/lib/email/unsubscribe";

export function creditsExpiringIdempotencyKey(grantId: string): string {
  return `credits-expiring:${grantId}`;
}

// Tells one account what is left of a grant and the day it expires.
// `credits` is the remaining amount as a decimal string.
export function buildCreditsExpiringEmail(user: EmailUser, credits: string, expiresAt: Date): EmailMessage {
  const from = bulkFrom();
  if (!from) throw new Error("No bulk sender configured.");
  const firstName = user.name.trim().split(/\s+/)[0] || user.name;
  return {
    from,
    to: user.email,
    replyTo: emailFrom() || from,
    subject: `Your ${formatUsdPlain(credits)} in AI credits expires ${formatCreditExpiry(expiresAt)}`,
    react: CreditsExpiringEmail({
      credits: formatUsdPlain(credits),
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
  };
}
