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
import { formatUsd } from "@/lib/credits/format-usd";
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

  const customValue = Number.parseInt(customAmount, 10);
  const customValid =
    Number.isFinite(customValue) &&
    customValue >= creditTopUpMinDollars &&
    customValue <= creditTopUpMaxDollars;

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
              {formatUsd(balance.data?.balance ?? "0")}
            </div>
          )}
          <p className="mt-1 text-sm text-muted-foreground">Available balance</p>
        </div>

        <div className="space-y-3">
          <Label>Buy credits</Label>
          <div className="flex flex-wrap gap-2">
            {creditTopUpPresetsDollars.map((amount) => (
              <Button
                disabled={checkout.isPending}
                key={amount}
                onClick={() => setCustomAmount(String(amount))}
                variant={customAmount === String(amount) ? "default" : "outline"}
              >
                ${amount}
              </Button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground" htmlFor="custom-amount">
                Amount (USD)
              </Label>
              <Input
                className="w-32"
                id="custom-amount"
                inputMode="numeric"
                max={creditTopUpMaxDollars}
                min={creditTopUpMinDollars}
                onChange={(event) => setCustomAmount(event.target.value)}
                placeholder="50"
                type="number"
                value={customAmount}
              />
            </div>
            <Button
              disabled={!customValid || checkout.isPending}
              onClick={() => startCheckout(customValue)}
            >
              {checkout.isPending ? "Starting…" : "Buy"}
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
        save({
          amountDollars: Number(form.get("amount")),
          enabled: form.get("enabled") === "on",
          thresholdDollars: Number(form.get("threshold")),
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
          <span>$</span>
          <Input
            className="w-20"
            defaultValue={data?.thresholdDollars ?? 10}
            min={0}
            name="threshold"
            type="number"
          />
        </div>
        <span>automatically buy</span>
        <div className="flex items-center gap-1">
          <span>$</span>
          <Input
            className="w-20"
            defaultValue={data?.amountDollars ?? creditTopUpDefaultDollars}
            min={5}
            name="amount"
            type="number"
          />
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
