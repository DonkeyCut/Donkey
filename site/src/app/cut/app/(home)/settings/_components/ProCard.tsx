"use client";

import {
  useOpenBillingPortal,
  useProSubscription,
  useStartCheckout,
} from "@/queries/billing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { activeProPromotion, CUT_PRO } from "@/app/cut/_components/landing/cutPricingPlans";
import { formatDeadline, minutesLeft } from "@/cut/components/SubscribeBonusPill";
import { track } from "@/lib/analytics";
import { formatUsd } from "@/lib/credits/format-usd";
import { formatCreditExpiry } from "@/lib/credits/top-up";
import { useSubscribeBonus } from "@/queries/credits";
import { useAccountConfig } from "@/queries/accountConfig";

// The promotion's last day, the way the card names it.
const lastDayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });

export function ProCard() {
  const pro = useProSubscription();
  const checkout = useStartCheckout();
  const portal = useOpenBillingPortal();
  const bonus = useSubscribeBonus();
  const config = useAccountConfig({ enabled: true });
  const promotion = config.data ? activeProPromotion(config.data.settings.proAllowancePromotion) : null;

  if (pro.isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  const data = pro.data;
  const isActive = data?.isActive ?? false;
  const offer = bonus.data;
  const offerOpen = offer?.status === "open";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          Donkey Pro
          {isActive && data ? (
            <Badge variant="default">{data.status}</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          A monthly usage allowance that resets each month — you can still buy
          credits any time.
        </CardDescription>
      </CardHeader>
      {promotion && !isActive ? (
        <CardContent className="text-sm">
          {promotion.lastDay !== null ? (
            <>
              <span className="font-medium">Get Pro by {lastDayLabel(promotion.lastDay)}</span> and every
              month that starts by then includes ${promotion.allowanceDollars} of AI, {promotion.multiplier}× the
              usual ${CUT_PRO.monthlyDollars}.
            </>
          ) : (
            <>
              Every month currently includes ${promotion.allowanceDollars} of AI, {promotion.multiplier}× the
              usual ${CUT_PRO.monthlyDollars}.
            </>
          )}
        </CardContent>
      ) : null}
      {isActive && data ? (
        <CardContent className="text-sm text-muted-foreground">
          <div className="space-y-1">
            <div className="text-foreground">
              {formatUsd(data.allowanceRemaining)} of{" "}
              {formatUsd(data.monthlyAllowance)} included left this month
            </div>
            <div>
              Renews:{" "}
              {data.currentPeriodEnd
                ? new Date(data.currentPeriodEnd).toLocaleDateString()
                : "—"}
            </div>
            {data.cancelAtPeriodEnd ? (
              <div className="text-foreground">
                Cancels at the end of the current period.
              </div>
            ) : null}
            {promotion ? (
              <div>
                {promotion.lastDay !== null
                  ? `Months that start by ${lastDayLabel(promotion.lastDay)} include $${promotion.allowanceDollars} of AI.`
                  : `Each new month includes $${promotion.allowanceDollars} of AI.`}
              </div>
            ) : null}
            {offer?.status === "claimed" ? (
              <div>Your {formatUsd(offer.dollars)} subscribe bonus landed in your credits.</div>
            ) : null}
          </div>
        </CardContent>
      ) : offer && offerOpen ? (
        <CardContent className="text-sm text-foreground">
          Subscribe for {CUT_PRO.price} by {formatDeadline(offer.closesAt)} and get a one-time{" "}
          {formatUsd(offer.dollars)} in credits
          {offer.creditsExpireAt
            ? `, spendable through ${formatCreditExpiry(new Date(offer.creditsExpireAt))}`
            : ""}
          .
        </CardContent>
      ) : null}
      <CardFooter className="gap-3">
        {isActive ? (
          <Button
            disabled={portal.isPending}
            onClick={() => {
              track("billing_portal_opened");
              portal.mutate(undefined, {
                onSuccess: (result) => window.location.assign(result.url),
              });
            }}
            variant="secondary"
          >
            {portal.isPending ? "Opening…" : "Manage billing"}
          </Button>
        ) : (
          <Button
            disabled={checkout.isPending}
            onClick={() => {
              track("pro_checkout_started");
              if (offer && offerOpen) {
                track("subscribe_bonus_checkout_started", {
                  dollars: Number(offer.dollars),
                  minutesLeft: minutesLeft(offer.closesAt, Date.now()),
                  source: "settings",
                });
              }
              checkout.mutate(undefined, {
                onSuccess: (result) => window.location.assign(result.url),
              });
            }}
          >
            {checkout.isPending ? "Starting…" : "Subscribe to Pro"}
          </Button>
        )}
        {checkout.isError || portal.isError ? (
          <span className="text-sm text-destructive">
            Billing is unavailable right now.
          </span>
        ) : null}
      </CardFooter>
    </Card>
  );
}
