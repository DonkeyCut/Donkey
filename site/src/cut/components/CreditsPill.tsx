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
import { compactCredits, creditsFromDollars, formatCredits } from "@/lib/credits/format-credits";
import { CREDITS_PILL_FLAG } from "@/lib/feature-flags";
import { useProSubscription } from "@/queries/billing";
import { creditBalanceQueryKey, useCreditBalance, type CreditBalance } from "@/queries/credits";
import { useAccountFlags } from "@/queries/featureFlags";

// The number sits in the bar as muted text; the pill's border and fill come
// up under the pointer, where they say it can be clicked.
const PILL =
  "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-3 py-1.5 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:border-border hover:bg-card hover:shadow-xs";

export function CreditsPill() {
  const user = useEngineUser();
  // Mounted above the account check so the hook order is stable; idle until
  // there is an account whose preference to read.
  const flags = useAccountFlags({ enabled: Boolean(user) });
  const shown = flags.data?.some((f) => f.id === CREDITS_PILL_FLAG && f.enabled) ?? false;
  if (!user || !shown) return null;
  return <BalancePill />;
}

/** Keeps the cached balance current with this tab's own charges: whoever
 * reads the balance mounts this, so it holds with the pill hidden too. */
export function useLiveCreditBalance() {
  const queryClient = useQueryClient();
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
}

function BalancePill() {
  const queryClient = useQueryClient();
  const balance = useCreditBalance();
  useLiveCreditBalance();
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
        aria-label={`Credits: ${formatCredits(balance.data.balance)}`}
        onClick={() =>
          track("cut_credits_pill_clicked", { credits: creditsFromDollars(balance.data.balance, "down"), dollars })
        }
        className={PILL}
      >
        <Zap className="size-3.5" />
        {compactCredits(balance.data.balance)}
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
        <span className="font-medium tabular-nums">{formatCredits(balance)}</span>
      </div>
    </div>
  );
}
