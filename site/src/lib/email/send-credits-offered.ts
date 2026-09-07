import {
  DONKEY_LOGO_CID,
  DONKEY_LOGO_PNG_BASE64,
} from "@/emails/_components/logo";
import CreditsOfferedEmail from "@/emails/credits-offered";
import { creditMicrosToString } from "@/lib/credits/amounts";
import { formatUsdPlain } from "@/lib/credits/format-usd";
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

// How long a claimed offer lives, as people read it.
export function describeCreditLifetime(days: number | null): string | null {
  if (days === null) return null;
  if (days % 365 === 0) return days === 365 ? "a year" : `${days / 365} years`;
  if (days % 30 === 0) return days === 30 ? "a month" : `${days / 30} months`;
  if (days % 7 === 0) return days === 7 ? "a week" : `${days / 7} weeks`;
  return days === 1 ? "a day" : `${days} days`;
}

// Tells the account credit is waiting and hands it the claim link. Credit
// given by hand is account mail, so it goes whatever the marketing choice;
// the footer still offers the opt-out.
export async function sendCreditsOfferedEmail(
  user: EmailUser,
  offer: { amountMicros: bigint; claimUrl: string; closesAt: Date; expiresAfterDays: number | null; id: string },
): Promise<void> {
  if (!isResendConfigured()) throw new ResendNotConfiguredError();
  const from = bulkFrom();
  if (!from) throw new Error("No bulk sender configured.");

  const credits = formatUsdPlain(creditMicrosToString(offer.amountMicros));
  const firstName = user.name.trim().split(/\s+/)[0] || user.name;
  const { error } = await getResend().emails.send(
    {
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
    },
    { idempotencyKey: `credits-offered:${offer.id}` },
  );
  if (error) {
    throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
  }
}
