"use client";

// A credit offer's face. The email's claim link opens the app home with the
// offer token in the address (?claim=…); this reads it, presents the offer,
// and lands the credit on a press. The credit waits for that press:
// link-prefetching mail scanners open URLs on the recipient's behalf, and a
// claim on load would start the credit's lifetime before the person saw it.
// Closing drops the token from the address, so a reload opens nothing.
import { useSearchParams } from "next/navigation";
import { Loader2, Sparkle } from "lucide-react";
import { useState } from "react";
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

function AddressedDialog() {
  const token = useSearchParams().get(PARAM);
  if (!token) return null;
  return <OpenDialog key={token} token={token} />;
}

// Only the token leaves the address; an open folder stays open. The native
// history call syncs into the router without a server round trip, so the
// close holds whatever the connection is doing.
function dropTokenFromAddress() {
  const url = new URL(window.location.href);
  url.searchParams.delete(PARAM);
  window.history.replaceState(null, "", url);
}

function OpenDialog({ token }: { token: string }) {
  const offer = useCreditOffer(token);
  const claim = useClaimCreditOffer();
  const [open, setOpen] = useState(true);
  const done = claim.data ?? (offer.data?.claimed ? { expiresAt: null } : null);
  // The dialog opens once the offer is known, at the size it keeps: the body
  // reserves two lines and every state ends in one row of buttons.
  if (offer.isPending) return null;
  const onClose = () => {
    setOpen(false);
    dropTokenFromAddress();
  };

  let title = "Claim your credits";
  let body: string;
  let footer: React.ReactNode;
  if (offer.isError) {
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
    body = `You have ${offer.data.credits} in AI credits. They\u2019re waiting for you.${
      offer.data.lifetime ? ` Once claimed, it\u2019s good for ${offer.data.lifetime}.` : ""
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
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="top-[18%] translate-y-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Sparkle className="size-5 shrink-0 fill-violet-500/25 text-violet-500" />
            {title}
          </DialogTitle>
          <DialogDescription className="min-h-10">{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mb-0 items-center border-0 bg-transparent p-0">
          {claim.isError && (
            <p className="text-sm text-destructive sm:mr-auto">
              {claim.error instanceof ApiError && claim.error.status === 403
                ? "This offer belongs to a different account. Sign in with the address the email was sent to."
                : claim.error instanceof ApiError && claim.error.status === 410
                ? "The claim window for this offer has closed."
                : "That didn\u2019t go through. Try again."}
            </p>
          )}
          {footer}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
