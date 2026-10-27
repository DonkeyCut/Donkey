"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";

import {
  useIntroOffer,
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
import { activeProPromotion, CUT_PRO, useCutPro } from "@/app/[locale]/cut/_components/landing/cutPricingPlans";
import { useApiErrorText } from "@/app/[locale]/cut/app/(home)/settings/_components/useApiErrorText";
import { useIntroTerms } from "@/cut/components/IntroOffer";
import { minutesLeft, useCreditLifeClause, useFormatDeadline } from "@/cut/components/SubscribeBonusPill";
import { track } from "@/lib/analytics";
import { creditCountLabel, creditsFromDollars, creditsPerDollar, formatCreditCount, formatCredits } from "@/lib/credits/format-credits";
import type { Locale } from "@/i18n/locales";
import { useSubscribeBonus } from "@/queries/credits";
import { useAccountConfig } from "@/queries/accountConfig";

// A whole-dollar allowance as the credits it buys: $20 → "20,000 credits".
const allowanceCredits = (dollars: number, locale: Locale) => creditCountLabel(dollars * creditsPerDollar, locale);

// The left-over half of "12,300 of 20,000 credits"; the total carries the unit.
const leftCount = (dollars: string, locale: Locale) => formatCreditCount(creditsFromDollars(dollars, "down"), locale);

export function ProCard() {
  const t = useTranslations("settings.pro");
  const locale = useLocale();
  const format = useFormatter();
  const proPlan = useCutPro();
  const apiErrorText = useApiErrorText();

  // The promotion's last day, the way the card names it.
  const lastDayLabel = (day: string) =>
    format.dateTime(new Date(`${day}T00:00:00Z`), { day: "numeric", month: "long", timeZone: "UTC" });

  const introTerms = useIntroTerms();
  const formatDeadline = useFormatDeadline();
  const creditLifeClause = useCreditLifeClause();
  const pro = useProSubscription();
  const checkout = useStartCheckout();
  const portal = useOpenBillingPortal();
  const bonus = useSubscribeBonus();
  const config = useAccountConfig({ enabled: true });
  const promotion = config.data ? activeProPromotion(config.data.settings.proAllowancePromotion) : null;
  const intro = useIntroOffer({ enabled: pro.data?.isActive === false });

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
          {t("title")}
          {isActive && data ? (
            <Badge variant="default">{t("status", { status: data.status ?? "" })}</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      {promotion && !isActive ? (
        <CardContent className="text-sm">
          {promotion.lastDay !== null
            ? t.rich("promotionUntil", {
                b: (chunks) => <span className="font-medium">{chunks}</span>,
                day: lastDayLabel(promotion.lastDay),
                allowance: allowanceCredits(promotion.allowanceDollars, locale),
                multiplier: format.number(promotion.multiplier),
                usual: allowanceCredits(CUT_PRO.monthlyDollars, locale),
              })
            : t("promotionOpen", {
                allowance: allowanceCredits(promotion.allowanceDollars, locale),
                multiplier: format.number(promotion.multiplier),
                usual: allowanceCredits(CUT_PRO.monthlyDollars, locale),
              })}
        </CardContent>
      ) : null}
      {isActive && data ? (
        <CardContent className="text-sm text-muted-foreground">
          <div className="space-y-1">
            <div className="text-foreground">
              {t("left", {
                left: leftCount(data.allowanceRemaining, locale),
                total: formatCredits(data.monthlyAllowance, locale),
              })}
            </div>
            {data.endsAt ? (
              <div className="text-foreground">
                {t("cancels", { date: format.dateTime(new Date(data.endsAt)) })}
              </div>
            ) : (
              <div>
                {t("renews", {
                  date: data.currentPeriodEnd ? format.dateTime(new Date(data.currentPeriodEnd)) : "—",
                })}
              </div>
            )}
            {promotion ? (
              <div>
                {promotion.lastDay !== null
                  ? t("activePromotionUntil", {
                      day: lastDayLabel(promotion.lastDay),
                      allowance: allowanceCredits(promotion.allowanceDollars, locale),
                    })
                  : t("activePromotionOpen", { allowance: allowanceCredits(promotion.allowanceDollars, locale) })}
              </div>
            ) : null}
            {offer?.status === "claimed" ? (
              <div>
                {t("bonusLanded", { credits: formatCredits(offer.dollars, locale), origin: offer.origin })}
              </div>
            ) : null}
          </div>
        </CardContent>
      ) : offer && offerOpen ? (
        <CardContent className="text-sm text-foreground">
          {t("subscribeOffer", {
            price: proPlan.price,
            deadline: formatDeadline(offer.closesAt),
            credits: formatCredits(offer.dollars, locale),
            lifeClause: creditLifeClause(offer),
          })}
        </CardContent>
      ) : null}
      {intro.data && !isActive ? (
        <CardContent className="text-sm text-foreground">
          {t("introDeadline", { terms: introTerms(intro.data), deadline: formatDeadline(intro.data.endsAt) })}
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
            {portal.isPending ? t("opening") : t("manage")}
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
            {checkout.isPending ? t("starting") : t("subscribe")}
          </Button>
        )}
        {checkout.isError || portal.isError ? (
          <span className="text-sm text-destructive">
            {apiErrorText(checkout.error ?? portal.error, t("unavailable"))}
          </span>
        ) : null}
      </CardFooter>
    </Card>
  );
}
