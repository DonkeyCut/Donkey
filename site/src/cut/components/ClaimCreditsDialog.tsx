"use client";

// A credit offer's face. The email's claim link opens the app home with the
// offer token in the address (?claim=…); this takes the token out of the
// address the moment it is read, holds it for the dialog's life, and lands the
// credit on a press. The credit waits for that press: link-prefetching mail
// scanners open URLs on the recipient's behalf, and a claim on load would
// start the credit's lifetime before the person saw it. The address is clean
// from the first paint, so a reload, a back step or a forward step opens
// nothing; the link itself opens a claimed offer as the credit it landed.
// An offer landed by subscribing has a Subscribe button in place of Claim:
// the press starts the Pro checkout, which carries the offer to the webhook.
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { claimOfferCopy, OfferButton, OfferDialog, OfferDismiss, subscribeOfferCopy } from "@/cut/components/OfferDialog";
import { useEngineUser } from "@/cut/lib/backend/hooks";
import { track } from "@/lib/analytics";
import { formatCreditExpiry } from "@/lib/credits/top-up";
import { ApiError } from "@/queries/apiClient";
import { useStartCheckout } from "@/queries/billing";
import { useClaimCreditOffer, useCreditOffer } from "@/queries/credits";

const PARAM = "claim";

// The address is read only once the account id has landed. The id is absent in
// the prerendered shell, and the shell's instant-navigation check fails a
// search-param read it cannot sample.
export function ClaimCreditsDialog() {
  const user = useEngineUser();
  return user ? <AddressedDialog /> : null;
}

// Only the token leaves the address; an open folder stays open. The native
// history call syncs into the router without a server round trip, so the
// drop holds whatever the connection is doing.
function dropTokenFromAddress() {
  const url = new URL(window.location.href);
  url.searchParams.delete(PARAM);
  window.history.replaceState(null, "", url);
}

function AddressedDialog() {
  const inAddress = useSearchParams().get(PARAM);
  // The token is held from the render that reads it; a new one in the address
  // replaces it.
  const [held, setHeld] = useState(inAddress);
  if (inAddress && inAddress !== held) setHeld(inAddress);
  useEffect(() => {
    if (inAddress) dropTokenFromAddress();
  }, [inAddress]);
  const token = inAddress ?? held;
  if (!token) return null;
  return <OpenDialog key={token} token={token} onClose={() => setHeld(null)} />;
}

function OpenDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const offer = useCreditOffer(token);
  const claim = useClaimCreditOffer();
  const checkout = useStartCheckout();
  const subscribe = () => {
    if (!offer.data) return;
    track("subscribe_bonus_checkout_started", {
      dollars: Number(offer.data.credits.replace(/[^0-9.]/g, "")),
      minutesLeft: offer.data.closesAt ? Math.max(0, Math.ceil((Date.parse(offer.data.closesAt) - Date.now()) / 60_000)) : 0,
      source: "email",
    });
    checkout.mutate({ offerToken: token }, { onSuccess: (result) => window.location.assign(result.url) });
  };
  // The card opens once the link is checked, as the offer it holds: its
  // banner, title and button are the offer's from the first paint. The body
  // reserves two lines and every state ends in one button, so the card keeps
  // its size as the offer is claimed.
  if (offer.isPending) return null;
  const done = claim.data ?? (offer.data?.claimed ? { expiresAt: offer.data.expiresAt } : null);

  let title: React.ReactNode;
  let body: React.ReactNode;
  let terms: React.ReactNode = null;
  let cta: React.ReactNode;
  let secondary: React.ReactNode = <OfferDismiss onClick={onClose}>Not now</OfferDismiss>;
  if (offer.isError) {
    const status = offer.error instanceof ApiError ? offer.error.status : null;
    title =
      status === 410 ? "This offer has expired" : status === 409 ? "You already have Pro" : "This link is no longer valid";
    body =
      status === 403
        ? "This offer belongs to a different account. Sign in with the address the email was sent to."
        : status === 410
          ? "The claim window for this offer has closed."
          : status === 409
            ? "This offer is for accounts without a Pro subscription."
            : "The offer it pointed to is gone.";
    cta = <OfferButton onClick={onClose}>OK</OfferButton>;
    secondary = null;
  } else if (done) {
    title = `${offer.data.credits} is on your account`;
    body = `${offer.data.credits} in AI credits is ready to spend.${
      done.expiresAt ? ` It expires ${formatCreditExpiry(new Date(done.expiresAt))}.` : ""
    }`;
    cta = <OfferButton onClick={onClose}>Start editing</OfferButton>;
    secondary = null;
  } else if (offer.data.claim === "subscribe") {
    title = `Get ${offer.data.credits} in credits with Pro`;
    ({ body, terms } = subscribeOfferCopy({
      credits: offer.data.credits,
      expiresAt: null,
      lifetimeDays: offer.data.lifetimeDays,
    }));
    cta = (
      <OfferButton disabled={checkout.isPending} onClick={subscribe}>
        {checkout.isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
        Subscribe to Pro
      </OfferButton>
    );
  } else {
    title = `${offer.data.credits} in credits is waiting`;
    ({ body, terms } = claimOfferCopy({
      credits: offer.data.credits,
      closesAt: offer.data.closesAt,
      lifetimeDays: offer.data.lifetimeDays,
    }));
    cta = (
      <OfferButton disabled={claim.isPending} onClick={() => claim.mutate(token)}>
        {claim.isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
        Claim {offer.data.credits}
      </OfferButton>
    );
  }

  const error = checkout.isError
    ? "Billing is unavailable right now."
    : claim.isError
      ? claim.error instanceof ApiError && claim.error.status === 403
        ? "This offer belongs to a different account. Sign in with the address the email was sent to."
        : claim.error instanceof ApiError && claim.error.status === 410
          ? "The claim window for this offer has closed."
          : "That didn’t go through. Try again."
      : null;

  return (
    <OfferDialog
      open
      onOpenChange={(next) => !next && onClose()}
      banner={offer.data?.claim === "subscribe" ? "subscribe" : "credits"}
      closesAt={offer.data && !done ? offer.data.closesAt : null}
      title={title}
      body={body}
      terms={terms}
      cta={cta}
      secondary={secondary}
      error={error}
    />
  );
}
