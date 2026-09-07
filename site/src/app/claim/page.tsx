import { Suspense } from "react";

import { ClaimCredits } from "@/app/claim/ClaimCredits";
import { LegalPageShell } from "@/app/legal/LegalPageShell";
import { creditMicrosToString } from "@/lib/credits/amounts";
import { formatUsdPlain } from "@/lib/credits/format-usd";
import { verifyCreditOfferToken } from "@/lib/credits/offers";
import { describeCreditLifetime } from "@/lib/email/send-credits-offered";
import { prisma } from "@/lib/prisma";

// Where the claim button in a credit offer email lands. The token is verified
// here, but the credit waits for a button press: link-prefetching mail
// scanners open URLs on the recipient's behalf, and a claim on load would
// start the credit's lifetime before the person ever saw it.
export default function ClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  return (
    <LegalPageShell>
      <h1>Your credits</h1>
      <Suspense fallback={<p>Checking this link…</p>}>
        <Offer searchParams={searchParams} />
      </Suspense>
    </LegalPageShell>
  );
}

async function Offer({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const offerId = token ? verifyCreditOfferToken(token) : null;
  const offer = offerId
    ? await prisma.creditOffer.findUnique({
        select: { amountMicros: true, claimedAt: true, expiresAfterDays: true },
        where: { id: offerId },
      })
    : null;
  if (!offer || !token) {
    return <p>This link is no longer valid.</p>;
  }
  return (
    <ClaimCredits
      claimed={offer.claimedAt !== null}
      credits={formatUsdPlain(creditMicrosToString(offer.amountMicros))}
      lifetime={describeCreditLifetime(offer.expiresAfterDays)}
      token={token}
    />
  );
}
