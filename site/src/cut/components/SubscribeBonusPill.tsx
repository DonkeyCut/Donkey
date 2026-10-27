"use client";

// The offer for subscribing in the top bar: while the account's offer is
// open, a pill names the credit and how long is left, and opens the offer
// itself. A bonus the app made opens once on its own the first time this tab
// sees it; an offer that came by email was presented by the email, so the
// pill only keeps it in view.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Gift } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { OfferButton, OfferDialog, OfferDismiss, useOfferCopy } from "@/cut/components/OfferDialog";
import { useEngineUser } from "@/cut/lib/backend/hooks";
import { useInvalidateOnSettle } from "@/cut/lib/hosted";
import { track } from "@/lib/analytics";
import { compactCredits, formatCredits } from "@/lib/credits/format-credits";
import { useStartCheckout } from "@/queries/billing";
import { subscribeBonusQueryKey, useSubscribeBonus, type SubscribeBonus } from "@/queries/credits";

const PILL =
  "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium tabular-nums text-foreground transition-colors hover:border-primary/60 hover:bg-primary/15";

const SEEN_KEY = "cut-subscribe-bonus-seen";

/** The minutes left on an offer, never below zero. */
export function minutesLeft(closesAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(closesAt) - now) / 60_000));
}

/** "3d left" past the day, "5h left" past the hour, "40m left" inside it. */
function timeLeftLabel(minutes: number, t: ReturnType<typeof useTranslations<"billing">>): string {
  if (minutes >= 24 * 60) {
    return t("subscribeBonus.daysLeft", { count: Math.floor(minutes / (24 * 60)) });
  }
  if (minutes >= 60) {
    return t("subscribeBonus.hoursLeft", { count: Math.floor(minutes / 60) });
  }
  return t("subscribeBonus.minutesLeft", { count: minutes });
}

/** How long the landed credit lasts, as the sentence after the offer. */
export function useCreditLifeClause(): (offer: {
  creditsExpireAt: string | null;
  creditsLifetimeDays: number | null;
}) => string {
  const { creditValidity } = useOfferCopy();
  return (offer) => {
    const valid = creditValidity({ expiresAt: offer.creditsExpireAt, lifetimeDays: offer.creditsLifetimeDays });
    return valid ? ` ${valid}` : "";
  };
}

/** The deadline as people read it in their own clock and language:
 * "Sep 8, 3:14 PM". */
export function useFormatDeadline(): (closesAt: string) => string {
  const format = useFormatter();
  return (closesAt) =>
    format.dateTime(new Date(closesAt), {
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
  const t = useTranslations("billing");
  const locale = useLocale();
  const { subscribeOfferCopy } = useOfferCopy();
  const queryClient = useQueryClient();
  const checkout = useStartCheckout();
  // A bonus the app made presents itself once: the first time a tab sees it
  // open.
  const [open, setOpen] = useState(() => offer.origin === "app" && !seenBefore(offer));
  const [now, setNow] = useState(() => Date.now());

  // The clock the label reads; a minute is as fine as the label gets.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  // The first showing of a bonus is recorded, so the next load leaves the
  // pill alone.
  useEffect(() => {
    if (offer.origin !== "app" || seenBefore(offer)) return;
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

  const credits = formatCredits(offer.dollars, locale);
  const timeLeft = timeLeftLabel(minutes, t);
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
        aria-label={t("subscribeBonus.pillLabel", { credits, timeLeft })}
        onClick={() => setOpen(true)}
      >
        <Gift className="size-3.5" />
        {t("subscribeBonus.pill", { credits: compactCredits(offer.dollars, locale), timeLeft })}
      </button>
      <OfferDialog
        open={open}
        onOpenChange={setOpen}
        banner="subscribe"
        title={t("claim.withProTitle", { credits })}
        closesAt={offer.closesAt}
        {...subscribeOfferCopy({
          credits,
          expiresAt: offer.creditsExpireAt,
          lifetimeDays: offer.creditsLifetimeDays,
        })}
        cta={
          <OfferButton disabled={checkout.isPending} onClick={subscribe}>
            {checkout.isPending ? t("subscribeBonus.starting") : t("subscribeToPro")}
          </OfferButton>
        }
        secondary={<OfferDismiss onClick={() => setOpen(false)}>{t("notNow")}</OfferDismiss>}
        error={checkout.isError ? t("billingUnavailable") : null}
      />
    </>
  );
}
