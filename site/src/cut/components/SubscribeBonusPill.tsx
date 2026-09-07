"use client";

// The subscribe bonus in the top bar: while the account's offer is open, a
// pill names the credit and how long is left, and opens the offer itself. The
// offer opens once on its own the first time this tab sees it.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Gift } from "lucide-react";
import { CUT_PRO } from "@/app/cut/_components/landing/cutPricingPlans";
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
import { useInvalidateOnSettle } from "@/cut/lib/hosted";
import { track } from "@/lib/analytics";
import { formatUsd } from "@/lib/credits/format-usd";
import { formatCreditExpiry } from "@/lib/credits/top-up";
import { useStartCheckout } from "@/queries/billing";
import { subscribeBonusQueryKey, useSubscribeBonus, type SubscribeBonus } from "@/queries/credits";

const PILL =
  "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium tabular-nums text-foreground transition-colors hover:border-primary/60 hover:bg-primary/15";

const SEEN_KEY = "cut-subscribe-bonus-seen";

/** The minutes left on an offer, never below zero. */
export function minutesLeft(closesAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(closesAt) - now) / 60_000));
}

/** "5h left" past the hour, "40m left" inside it. */
export function timeLeftLabel(minutes: number): string {
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h left`;
  return `${minutes}m left`;
}

/** The deadline as people read it in their own clock: "Sep 8, 3:14 PM". */
export function formatDeadline(closesAt: string): string {
  return new Date(closesAt).toLocaleString("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });
}

function seenBefore(offer: SubscribeBonus): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === offer.openedAt;
  } catch {
    return false;
  }
}

function markSeen(offer: SubscribeBonus): void {
  try {
    localStorage.setItem(SEEN_KEY, offer.openedAt);
  } catch {
    // A browser that keeps nothing shows the offer again next load.
  }
}

export function SubscribeBonusPill() {
  const user = useEngineUser();
  const offer = useSubscribeBonus({ enabled: Boolean(user) });
  // A charge from this tab may have been the one that opened the offer; the
  // re-read brings the pill up without waiting on the poll.
  useInvalidateOnSettle(subscribeBonusQueryKey);

  if (!user || offer.data?.status !== "open") return null;
  return <OpenOffer key={offer.data.openedAt} offer={offer.data} />;
}

function OpenOffer({ offer }: { offer: SubscribeBonus }) {
  const queryClient = useQueryClient();
  const checkout = useStartCheckout();
  // The offer presents itself once: the first time a tab sees it open.
  const [open, setOpen] = useState(() => !seenBefore(offer));
  const [now, setNow] = useState(() => Date.now());

  // The clock the label reads; a minute is as fine as the label gets.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  // The first showing is recorded, so the next load leaves the pill alone.
  useEffect(() => {
    if (seenBefore(offer)) return;
    markSeen(offer);
    track("subscribe_bonus_offered", { dollars: Number(offer.dollars) });
  }, [offer]);

  const minutes = minutesLeft(offer.closesAt, now);
  // Past the deadline the server says closed; ask it.
  useEffect(() => {
    if (minutes > 0) return;
    void queryClient.invalidateQueries({ queryKey: subscribeBonusQueryKey });
  }, [minutes, queryClient]);
  if (minutes === 0) return null;

  const dollars = formatUsd(offer.dollars);
  const subscribe = () => {
    track("subscribe_bonus_checkout_started", {
      dollars: Number(offer.dollars),
      minutesLeft: minutes,
      source: "editor",
    });
    checkout.mutate(undefined, {
      onSuccess: (result) => window.location.assign(result.url),
    });
  };

  return (
    <>
      <button
        type="button"
        className={PILL}
        aria-label={`${dollars} in credits with Pro, ${timeLeftLabel(minutes)}`}
        onClick={() => setOpen(true)}
      >
        <Gift className="size-3.5" />
        {dollars} with Pro · {timeLeftLabel(minutes)}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Get {dollars} in credits with Pro</DialogTitle>
            <DialogDescription>
              You have used half of your signup credits. Subscribe to Pro for {CUT_PRO.price} by{" "}
              {formatDeadline(offer.closesAt)} and a one-time {dollars} in credits lands in your account
              {offer.creditsExpireAt
                ? `, spendable through ${formatCreditExpiry(new Date(offer.creditsExpireAt))}`
                : ""}
              .
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Not now
            </Button>
            <Button disabled={checkout.isPending} onClick={subscribe}>
              {checkout.isPending ? "Starting…" : "Subscribe to Pro"}
            </Button>
          </DialogFooter>
          {checkout.isError ? (
            <p className="text-sm text-destructive">Billing is unavailable right now.</p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
