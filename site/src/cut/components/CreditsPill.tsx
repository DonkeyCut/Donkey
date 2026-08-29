"use client";

// The top bar's balance: what the account can still spend on hosted work —
// chat, generation, voice — so a session can be planned around it. Reads as a
// number and leads to the billing page.
import { useEffect } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Coins } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEngineUser } from "@/cut/lib/backend/hooks";
import { useHostedBalance } from "@/cut/lib/hosted";
import { useCutBase } from "@/cut/lib/nav";
import { track } from "@/lib/analytics";
import { formatUsd } from "@/lib/credits/format-usd";
import { CREDITS_PILL_FLAG } from "@/lib/feature-flags";
import { creditBalanceQueryKey, useCreditBalance, type CreditBalance } from "@/queries/credits";
import { useAccountFlags } from "@/queries/featureFlags";

// The number sits in the bar as muted text; the pill's border and fill come
// up under the pointer, where they say it can be clicked.
const PILL =
  "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-transparent px-3 py-1.5 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:border-border hover:bg-card hover:shadow-xs";

/** A hosted call that answered with no balance was charged after its
 * response left; the re-read waits for the charge to land. */
const SETTLE_DELAY_MS = 1500;

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
  const base = useCutBase();
  const queryClient = useQueryClient();
  const balance = useCreditBalance();
  const reported = useHostedBalance((s) => s.balance);
  const settled = useHostedBalance((s) => s.settled);

  // A charged call reported the balance it left: that is the balance, with no
  // request to make.
  useEffect(() => {
    if (reported === null) return;
    queryClient.setQueryData<CreditBalance>(creditBalanceQueryKey, (prev) =>
      prev ? { ...prev, balance: reported } : prev
    );
  }, [reported, queryClient]);
  // A call that answered without one: re-read once its charge has landed.
  // Only the count moving matters; the mount value is whatever the page has
  // done so far.
  useEffect(() => {
    if (settled === 0) return;
    const id = setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: creditBalanceQueryKey }),
      SETTLE_DELAY_MS
    );
    return () => clearTimeout(id);
  }, [settled, queryClient]);
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
  const message =
    dollars > 0
      ? `${formatUsd(balance.data.balance)} credits remaining`
      : "No credits left";
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              href={`${base}/settings`}
              aria-label={`Credits: ${compactUsd(dollars)}`}
              onClick={() => track("cut_credits_pill_clicked", { dollars })}
              className={PILL}
            />
          }
        >
          <Coins className="size-3.5" />
          {compactUsd(dollars)}
        </TooltipTrigger>
        <TooltipContent side="bottom">{message}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
