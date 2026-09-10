import { DONKEY_LOGO_CID, DONKEY_LOGO_PNG_BASE64 } from "@/emails/_components/logo";
import CreditsOfferedEmail from "@/emails/credits-offered";
import { creditMicrosToString } from "@/lib/credits/amounts";
import { formatUsdPlain } from "@/lib/credits/format-usd";
import { formatCreditExpiry } from "@/lib/credits/top-up";
import { bulkFrom, emailFrom, type EmailMessage, type EmailUser } from "@/lib/email/resend";
import { unsubscribeActionUrl, unsubscribePageUrl } from "@/lib/email/unsubscribe";

// How long a claimed offer lives, as people read it.
export function describeCreditLifetime(days: number | null): string | null {
  if (days === null) return null;
  if (days % 365 === 0) return days === 365 ? "a year" : `${days / 365} years`;
  if (days % 30 === 0) return days === 30 ? "a month" : `${days / 30} months`;
  if (days % 7 === 0) return days === 7 ? "a week" : `${days / 7} weeks`;
  return days === 1 ? "a day" : `${days} days`;
}

export function creditsOfferedIdempotencyKey(offerId: string): string {
  return `credits-offered:${offerId}`;
}

// Tells the account credit is waiting and hands it the claim link. Credit
// given by hand is account mail, so it goes whatever the marketing choice;
// the footer still offers the opt-out.
export function buildCreditsOfferedEmail(
  user: EmailUser,
  offer: { amountMicros: bigint; claimUrl: string; closesAt: Date; expiresAfterDays: number | null },
): EmailMessage {
  const from = bulkFrom();
  if (!from) throw new Error("No bulk sender configured.");
  const credits = formatUsdPlain(creditMicrosToString(offer.amountMicros));
  const firstName = user.name.trim().split(/\s+/)[0] || user.name;
  return {
    from,
    to: user.email,
    replyTo: emailFrom() || from,
    subject: `${credits} in AI credits is waiting for you`,
    react: CreditsOfferedEmail({
      claimBy: formatCreditExpiry(offer.closesAt),
      claimUrl: offer.claimUrl,
      credits,
      lifetime: describeCreditLifetime(offer.expiresAfterDays),
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
