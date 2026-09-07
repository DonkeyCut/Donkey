"use client";

// A credit offer's face. The email's claim link opens the app home with the
// offer token in the address (?claim=…); this reads it, presents the offer,
// and lands the credit on a press. The credit waits for that press:
// link-prefetching mail scanners open URLs on the recipient's behalf, and a
// claim on load would start the credit's lifetime before the person saw it.
// Closing drops the token from the address, so a reload opens nothing.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
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
  const params = useSearchParams();
  const token = params.get(PARAM);
  const router = useRouter();
  const pathname = usePathname();
  if (!token) return null;
  // Only the token leaves the address; an open folder stays open.
  const close = () => {
    const rest = new URLSearchParams(params);
    rest.delete(PARAM);
    const search = rest.toString();
    router.replace(search ? `${pathname}?${search}` : pathname);
  };
  return <OpenDialog key={token} token={token} onClose={close} />;
}

function OpenDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const offer = useCreditOffer(token);
  const claim = useClaimCreditOffer();
  const done = claim.data ?? (offer.data?.claimed ? { expiresAt: null } : null);

  let title = "Your credits";
  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (offer.isPending) {
    body = "Checking this link…";
    footer = null;
  } else if (offer.isError) {
    title = "This link is no longer valid";
    body =
      offer.error instanceof ApiError && offer.error.status === 403
        ? "This offer belongs to a different account. Sign in with the address the email was sent to."
        : "The offer it pointed to is gone.";
    footer = <Button onClick={onClose}>OK</Button>;
  } else if (done) {
    body = `${offer.data.credits} in AI credits is on your account.${
      done.expiresAt ? ` It expires ${formatCreditExpiry(new Date(done.expiresAt))}.` : ""
    }`;
    footer = <Button onClick={onClose}>Start editing</Button>;
  } else {
    body = `${offer.data.credits} in AI credits is waiting for you.${
      offer.data.lifetime ? ` Once claimed, it is good for ${offer.data.lifetime}.` : ""
    }`;
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        {footer && <DialogFooter>{footer}</DialogFooter>}
        {claim.isError && (
          <p className="text-sm text-destructive">
            {claim.error instanceof ApiError && claim.error.status === 403
              ? "This offer belongs to a different account. Sign in with the address the email was sent to."
              : "That didn't go through. Try again."}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
