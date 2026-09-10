"use client";

// The top bar's balance: what the account can still spend on hosted work —
// chat, generation, voice — so a session can be planned around it. Reads as a
// number; clicking it opens the plan card with the exact balance and the way
// into Pro.
import { useEffect } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useEngineUser } from "@/cut/lib/backend/hooks";
import { useHostedBalance, useInvalidateOnSettle } from "@/cut/lib/hosted";
import { useCutBase } from "@/cut/lib/nav";
import { useUpgradeToPro } from "@/cut/lib/proUpgrade";
import { track } from "@/lib/analytics";
import { formatUsd } from "@/lib/credits/format-usd";
import { CREDITS_PILL_FLAG } from "@/lib/feature-flags";
import { useProSubscription } from "@/queries/billing";
import { creditBalanceQueryKey, useCreditBalance, type CreditBalance } from "@/queries/credits";
import { useAccountFlags } from "@/queries/featureFlags";

// The number sits in the bar as muted text; the pill's border and fill come
// up under the pointer, where they say it can be clicked.
const PILL =
  "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-3 py-1.5 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:border-border hover:bg-card hover:shadow-xs";

/** The bar's reading of a balance: cents while there is less than $10, where
 * each one changes what the next generation can be, and whole dollars past
 * that, where they are noise. A round amount drops the ".00" either way. */
export function compactUsd(dollars: number): string {
  const cents = Math.round(dollars * 100);
  const showCents = dollars < 10 && cents % 100 !== 0;
  return dollars.toLocaleString("en-US", {
    currency: "USD",
    style: "currency",
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  });
}

export function CreditsPill() {
  const user = useEngineUser();
  // Mounted above the account check so the hook order is stable; idle until
  // there is an account whose preference to read.
  const flags = useAccountFlags({ enabled: Boolean(user) });
  const shown = flags.data?.some((f) => f.id === CREDITS_PILL_FLAG && f.enabled) ?? false;
  if (!user || !shown) return null;
  return <BalancePill />;
}

function BalancePill() {
  const queryClient = useQueryClient();
  const balance = useCreditBalance();
  const reported = useHostedBalance((s) => s.balance);

  // A charged call reported the balance it left: that is the balance, with no
  // request to make.
  useEffect(() => {
    if (reported === null) return;
    queryClient.setQueryData<CreditBalance>(creditBalanceQueryKey, (prev) =>
      prev ? { ...prev, balance: reported } : prev
    );
  }, [reported, queryClient]);
  // A call that answered without one: re-read once its charge has landed.
  useInvalidateOnSettle(creditBalanceQueryKey);
  // Background work — renders, cloud jobs — charges without a call from this
  // tab, and a top-up happens on another page; a slow poll keeps the number
  // honest between them, and a focus refetch catches the trip back from billing.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void queryClient.invalidateQueries({ queryKey: creditBalanceQueryKey });
    }, 60_000);
    const onFocus = () => void queryClient.invalidateQueries({ queryKey: creditBalanceQueryKey });
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [queryClient]);

  if (!balance.data) return null;
  const dollars = Number.parseFloat(balance.data.balance) || 0;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Credits: ${compactUsd(dollars)}`}
        onClick={() => track("cut_credits_pill_clicked", { dollars })}
        className={PILL}
      >
        <Zap className="size-3.5" />
        {compactUsd(dollars)}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={6} className="w-64 p-0">
        <PlanCard balance={balance.data.balance} />
      </PopoverContent>
    </Popover>
  );
}

// Mounted only while the card is open, so the plan query runs on demand. A
// free account is sold Pro; a Pro account already pays, so its button goes to
// billing, where credits are bought.
function PlanCard({ balance }: { balance: string }) {
  const base = useCutBase();
  const pro = useProSubscription();
  const upgrade = useUpgradeToPro();
  const isPro = pro.data?.isActive === true;
  return (
    <div className="text-sm">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="font-semibold">{isPro ? "Pro" : "Free"}</span>
        {pro.data &&
          (isPro ? (
            <Button size="sm" render={<Link href={`${base}/settings`} />}>
              Buy credits
            </Button>
          ) : (
            <Button size="sm" disabled={upgrade.isPending} onClick={upgrade.start}>
              {upgrade.isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
              Upgrade
            </Button>
          ))}
      </div>
      <div className="flex items-center gap-2.5 border-t border-border px-4 py-3">
        <Zap className="size-4 text-muted-foreground" />
        <span className="flex-1 text-muted-foreground">Credits</span>
        <span className="font-medium tabular-nums">{formatUsd(balance)}</span>
      </div>
    </div>
  );
}
