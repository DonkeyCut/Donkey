"use client";

// A credit offer's face. The email's claim link opens the app home with the
// offer token in the address (?claim=…); this reads it, presents the offer,
// and lands the credit on a press. The credit waits for that press:
// link-prefetching mail scanners open URLs on the recipient's behalf, and a
// claim on load would start the credit's lifetime before the person saw it.
// Closing drops the token from the address, so a reload opens nothing.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, Sparkle } from "lucide-react";
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
  // The dialog opens once the offer is known, at the size it keeps: the body
  // reserves two lines and every state ends in one row of buttons.
  if (offer.isPending) return null;

  let title = "Claim your credits";
  let body: string;
  let footer: React.ReactNode;
  if (offer.isError) {
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
    body = `You have ${offer.data.credits} in AI credits. They\u2019re waiting for you.${
      offer.data.lifetime ? ` Once claimed, it\u2019s good for ${offer.data.lifetime}.` : ""
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
                : "That didn\u2019t go through. Try again."}
            </p>
          )}
          {footer}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
