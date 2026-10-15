"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { track } from "@/lib/analytics";
import {
  creditCountLabel,
  creditsPerDollar,
  dollarsForCredits,
  formatCredits,
} from "@/lib/credits/format-credits";
import { formatUsdPlain } from "@/lib/credits/format-usd";
import {
  creditTopUpDefaultDollars,
  creditTopUpMaxDollars,
  creditTopUpMinDollars,
  creditTopUpPresetsDollars,
} from "@/lib/credits/top-up";
import { ApiError } from "@/queries/apiClient";
import {
  useCreditAutoReload,
  useCreditBalance,
  useStartCreditCheckout,
  useUpdateCreditAutoReload,
} from "@/queries/credits";

// Credits are sold in whole thousands, so every pack is a whole-dollar Stripe
// charge: 5,000 credits is $5.
const creditPackStep = creditsPerDollar;
const minPackCredits = creditTopUpMinDollars * creditsPerDollar;
const maxPackCredits = creditTopUpMaxDollars * creditsPerDollar;

/** Whole dollars a credit amount typed in a field costs, or null when it is not a whole pack. */
function packDollars(value: string): number | null {
  // The whole field must be a count: "5000.9" or "5e3" is no pack.
  const credits = value.trim() === "" ? Number.NaN : Number(value);
  if (!Number.isInteger(credits) || credits % creditPackStep !== 0) {
    return null;
  }
  return dollarsForCredits(credits);
}

export function CreditsCard() {
  const balance = useCreditBalance();
  const checkout = useStartCreditCheckout();
  const [customAmount, setCustomAmount] = useState("");

  const startCheckout = (amountDollars: number) => {
    track("credits_checkout_started", { amountDollars });
    checkout.mutate(amountDollars, {
      onSuccess: (result) => window.location.assign(result.url),
    });
  };

  // The field holds credits; checkout takes the dollars they cost.
  const customDollars = packDollars(customAmount);
  const customValid =
    customDollars !== null &&
    customDollars >= creditTopUpMinDollars &&
    customDollars <= creditTopUpMaxDollars;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Credits</CardTitle>
        <CardDescription>
          Pay-as-you-go balance for the Donkey app. Buy more any time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          {balance.isLoading ? (
            <Skeleton className="h-9 w-32" />
          ) : (
            <div className="text-3xl font-semibold tabular-nums">
              {formatCredits(balance.data?.balance ?? "0")}
            </div>
          )}
          <p className="mt-1 text-sm text-muted-foreground">Available balance</p>
        </div>

        <div className="space-y-3">
          <Label>Buy credits</Label>
          <div className="flex flex-wrap gap-2">
            {creditTopUpPresetsDollars.map((amount) => {
              const credits = String(amount * creditsPerDollar);
              return (
                <Button
                  disabled={checkout.isPending}
                  key={amount}
                  onClick={() => setCustomAmount(credits)}
                  variant={customAmount === credits ? "default" : "outline"}
                >
                  {creditCountLabel(amount * creditsPerDollar)} · {formatUsdPlain(String(amount))}
                </Button>
              );
            })}
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground" htmlFor="custom-amount">
                Credits
              </Label>
              <Input
                className="w-32"
                id="custom-amount"
                inputMode="numeric"
                max={maxPackCredits}
                min={minPackCredits}
                onChange={(event) => setCustomAmount(event.target.value)}
                placeholder="50000"
                step={creditPackStep}
                type="number"
                value={customAmount}
              />
            </div>
            <Button
              disabled={!customValid || checkout.isPending}
              onClick={() => customDollars !== null && startCheckout(customDollars)}
            >
              {checkout.isPending
                ? "Starting…"
                : customValid
                  ? `Buy for ${formatUsdPlain(String(customDollars))}`
                  : "Buy"}
            </Button>
          </div>
          {checkout.isError ? (
            <p className="text-sm text-destructive">
              Couldn&apos;t start checkout. Try again in a moment.
            </p>
          ) : null}
        </div>

        <AutoReloadSection
          onNeedsCard={() => startCheckout(creditTopUpDefaultDollars)}
        />
      </CardContent>
    </Card>
  );
}

function AutoReloadSection({ onNeedsCard }: { onNeedsCard: () => void }) {
  const autoReload = useCreditAutoReload();
  const update = useUpdateCreditAutoReload();
  const [needsCard, setNeedsCard] = useState(false);

  if (autoReload.isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }

  const data = autoReload.data;
  const enabled = data?.enabled ?? false;

  const save = (next: {
    enabled: boolean;
    thresholdDollars: number;
    amountDollars: number;
  }) => {
    setNeedsCard(false);
    track("credit_auto_reload_saved", next);
    update.mutate(next, {
      onError: (error) => {
        if (error instanceof ApiError && error.code === "no_payment_method") {
          setNeedsCard(true);
        }
      },
    });
  };

  return (
    <form
      className="space-y-3 border-t pt-5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        // The fields hold credits; the saved config is in whole dollars.
        save({
          amountDollars: Math.round(dollarsForCredits(Number(form.get("amount")))),
          enabled: form.get("enabled") === "on",
          thresholdDollars: Math.round(dollarsForCredits(Number(form.get("threshold")))),
        });
      }}
    >
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          className="size-4 accent-primary"
          defaultChecked={enabled}
          name="enabled"
          type="checkbox"
        />
        Auto-reload when my balance runs low
      </label>
      <div className="flex flex-wrap items-end gap-3 text-sm text-muted-foreground">
        <span>When balance falls below</span>
        <div className="flex items-center gap-1">
          <Input
            className="w-28"
            defaultValue={(data?.thresholdDollars ?? 10) * creditsPerDollar}
            min={0}
            name="threshold"
            step={creditPackStep}
            type="number"
          />
          <span>credits</span>
        </div>
        <span>automatically buy</span>
        <div className="flex items-center gap-1">
          <Input
            className="w-28"
            defaultValue={(data?.amountDollars ?? creditTopUpDefaultDollars) * creditsPerDollar}
            max={maxPackCredits}
            min={minPackCredits}
            name="amount"
            step={creditPackStep}
            type="number"
          />
          <span>credits</span>
        </div>
        <Button disabled={update.isPending} size="sm" type="submit">
          {update.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {data?.status === "failed" && data.lastError ? (
        <p className="text-sm text-destructive">
          Last auto-reload failed: {data.lastError}
        </p>
      ) : null}
      {needsCard ? (
        <p className="text-sm text-muted-foreground">
          Auto-reload needs a saved card.{" "}
          <button
            className="text-primary underline-offset-4 hover:underline"
            onClick={onNeedsCard}
            type="button"
          >
            Buy credits once
          </button>{" "}
          to save one, then turn this on.
        </p>
      ) : null}
    </form>
  );
}
