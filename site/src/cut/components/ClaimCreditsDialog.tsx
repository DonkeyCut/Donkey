"use client";

// A credit offer's face. The email's claim link opens the app home with the
// offer token in the address (?claim=…); this takes the token out of the
// address the moment it is read, holds it for the dialog's life, and lands the
// credit on a press. The credit waits for that press: link-prefetching mail
// scanners open URLs on the recipient's behalf, and a claim on load would
// start the credit's lifetime before the person saw it. The address is clean
// from the first paint, so a reload, a back step or a forward step opens
// nothing; the link itself opens a claimed offer as the credit it landed.
import { useSearchParams } from "next/navigation";
import { Loader2, Sparkle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEngineUser } from "@/cut/lib/backend/hooks";
import { formatCreditExpiry } from "@/lib/credits/top-up";
import { ApiError } from "@/queries/apiClient";
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
  // The dialog opens at once, checking the link, at the size it keeps: the
  // body reserves two lines and every state ends in one row of buttons.
  const done = claim.data ?? (offer.data?.claimed ? { expiresAt: offer.data.expiresAt } : null);

  let title = "Claim your credits";
  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (offer.isPending) {
    body = (
      <span className="flex items-center gap-2">
        <Loader2 className="size-4 shrink-0 animate-spin" />
        Checking your offer…
      </span>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={onClose}>
          Not now
        </Button>
        <Button disabled>Claim</Button>
      </>
    );
  } else if (offer.isError) {
    const status = offer.error instanceof ApiError ? offer.error.status : null;
    title = status === 410 ? "This offer has expired" : "This link is no longer valid";
    body =
      status === 403
        ? "This offer belongs to a different account. Sign in with the address the email was sent to."
        : status === 410
          ? "The claim window for this offer has closed."
          : "The offer it pointed to is gone.";
    footer = <Button onClick={onClose}>OK</Button>;
  } else if (done) {
    body = `${offer.data.credits} in AI credits is on your account.${
      done.expiresAt ? ` It expires ${formatCreditExpiry(new Date(done.expiresAt))}.` : ""
    }`;
    footer = <Button onClick={onClose}>Start editing</Button>;
  } else {
    body = `You have ${offer.data.credits} in AI credits. They’re waiting for you.${
      offer.data.lifetime ? ` Once claimed, it’s good for ${offer.data.lifetime}.` : ""
    }${offer.data.closesAt ? ` Claim by ${formatCreditExpiry(new Date(offer.data.closesAt))}.` : ""}`;
    footer = (
      <>
        <Button variant="ghost" onClick={onClose}>
          Not now
        </Button>
        <Button disabled={claim.isPending} onClick={() => claim.mutate(token)}>
          {claim.isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
          Claim {offer.data.credits}
        </Button>
      </>
    );
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="top-[18%] translate-y-0 px-6 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Sparkle className="size-5 shrink-0 fill-violet-500/25 text-violet-500" />
            {title}
          </DialogTitle>
          <DialogDescription className="min-h-12 text-base">{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mb-0 items-center border-0 bg-transparent p-0">
          {claim.isError && (
            <p className="text-sm text-destructive sm:mr-auto">
              {claim.error instanceof ApiError && claim.error.status === 403
                ? "This offer belongs to a different account. Sign in with the address the email was sent to."
                : claim.error instanceof ApiError && claim.error.status === 410
                ? "The claim window for this offer has closed."
                : "That didn’t go through. Try again."}
            </p>
          )}
          {footer}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
