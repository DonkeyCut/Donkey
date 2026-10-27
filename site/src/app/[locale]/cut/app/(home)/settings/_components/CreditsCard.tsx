"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { useApiErrorText } from "@/app/[locale]/cut/app/(home)/settings/_components/useApiErrorText";

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
  const t = useTranslations("settings.credits");
  const locale = useLocale();
  const apiErrorText = useApiErrorText();
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
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          {balance.isLoading ? (
            <Skeleton className="h-9 w-32" />
          ) : (
            <div className="text-3xl font-semibold tabular-nums">
              {formatCredits(balance.data?.balance ?? "0", locale)}
            </div>
          )}
          <p className="mt-1 text-sm text-muted-foreground">{t("available")}</p>
        </div>

        <div className="space-y-3">
          <Label>{t("buy")}</Label>
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
                  {t("preset", {
                    credits: creditCountLabel(amount * creditsPerDollar, locale),
                    price: formatUsdPlain(String(amount), locale),
                  })}
                </Button>
              );
            })}
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground" htmlFor="custom-amount">
                {t("customLabel")}
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
                ? t("starting")
                : customValid
                  ? t("buyFor", { price: formatUsdPlain(String(customDollars), locale) })
                  : t("buyPlain")}
            </Button>
          </div>
          {checkout.isError ? (
            <p className="text-sm text-destructive">
              {apiErrorText(checkout.error, t("checkoutFailed"), {
                max: creditCountLabel(maxPackCredits, locale),
                min: creditCountLabel(minPackCredits, locale),
              })}
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
  const t = useTranslations("settings.credits");
  const apiErrorText = useApiErrorText();
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
        {t("autoReload")}
      </label>
      <div className="flex flex-wrap items-end gap-3 text-sm text-muted-foreground">
        <span>{t("fallsBelow")}</span>
        <div className="flex items-center gap-1">
          <Input
            className="w-28"
            defaultValue={(data?.thresholdDollars ?? 10) * creditsPerDollar}
            min={0}
            name="threshold"
            step={creditPackStep}
            type="number"
          />
          <span>{t("unit")}</span>
        </div>
        <span>{t("thenBuy")}</span>
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
          <span>{t("unit")}</span>
        </div>
        <Button disabled={update.isPending} size="sm" type="submit">
          {update.isPending ? t("saving") : t("save")}
        </Button>
      </div>
      {data?.status === "failed" && data.lastError ? (
        <p className="text-sm text-destructive">
          {t("lastFailed", { error: data.lastError })}
        </p>
      ) : null}
      {needsCard ? (
        <p className="text-sm text-muted-foreground">
          {t.rich("needsCard", {
            buy: (chunks) => (
              <button
                className="text-primary underline-offset-4 hover:underline"
                onClick={onNeedsCard}
                type="button"
              >
                {chunks}
              </button>
            ),
          })}
        </p>
      ) : update.isError ? (
        <p className="text-sm text-destructive">{apiErrorText(update.error, t("saveFailed"))}</p>
      ) : null}
    </form>
  );
}
