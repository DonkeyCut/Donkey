"use client";

import { ArrowLeft, Check, Loader2, Sparkles } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

import { TapedCard } from "@/app/_components/landing/LandingPrimitives";
import type { CardColor } from "@/app/_components/landing/theme";
import { useCutPlans, type PlanCopy, type PlanFeature } from "@/app/[locale]/cut/_components/landing/cutPricingPlans";
import { Button } from "@/components/ui/button";
import { priceLabel } from "@/cut/components/IntroOffer";
import { OfferSticker } from "@/cut/components/OfferSticker";
import { usePlanCheckout } from "@/cut/lib/proUpgrade";
import { track } from "@/lib/analytics";
import { RECOMMENDED_PLAN, type PaidPlan } from "@/lib/billing/plans";
import type { OnboardingRun } from "@/lib/onboarding/sequence";
import { cn } from "@/lib/utils";
import { useIntroOffer, type IntroOffer } from "@/queries/billing";

import "../onboarding.css";

// The landing's own card colors, so a plan looks the same wherever it's met.
const PLAN_CARD: Record<PaidPlan, { color: CardColor; tapeColor: CardColor }> = {
  plus: { color: "cream", tapeColor: "mint" },
  pro: { color: "coral", tapeColor: "yellow" },
  max: { color: "cream", tapeColor: "pink" },
};

// The sequence's last word: the paid plans side by side, Pro marked the best
// value, and free the default under them. The benefits sit in each card so
// nobody has to take a price on faith. Checkout is the one the upgrade modal
// starts. While the intro offer is open the Pro card prices the discount and
// counts down to its end.
export function PlansSlide({ run, onSkipPro }: { run: OnboardingRun; onSkipPro: () => void }) {
  const t = useTranslations("onboarding.plans");
  const plans = useCutPlans();
  const checkout = usePlanCheckout({ surface: "onboarding" });
  const intro = useIntroOffer();
  const offer = intro.data ?? null;

  // Reported once the offer read settles, so the event says whether the
  // discount was on the card.
  const tracked = useRef(false);
  useEffect(() => {
    if (intro.isPending || tracked.current) {
      return;
    }
    tracked.current = true;
    track("onboarding_plans_shown", { source: run, intro: intro.data?.percentOff ?? 0 });
  }, [intro.isPending, intro.data, run]);

  return (
    <div className="mx-auto w-full max-w-[1040px]">
      <h2 className="text-center text-[clamp(24px,3vw,32px)] leading-[1.1] font-semibold tracking-[-0.02em]">
        {t("title")}
      </h2>
      <p className="mt-3 text-center text-[16px] text-foreground/70">
        {t("subtitle")}
      </p>

      {/* A narrow window scrolls the cards sideways. The row bleeds past the
          slide's gutter to the screen edge so the next card peeks in on the
          right, and the top padding keeps the tape and offer sticker. The
          recommended plan comes first so it is the one on screen when the
          slide opens. */}
      <div className="-mx-6 mt-3 flex scroll-px-6 snap-x snap-mandatory gap-4 overflow-x-auto px-6 pt-5 pb-3 [scrollbar-width:none] md:mx-0 md:mt-8 md:grid md:grid-cols-3 md:items-stretch md:gap-5 md:overflow-visible md:p-0 [&::-webkit-scrollbar]:hidden">
        {plans.map((copy) => (
          <div
            key={copy.plan}
            className={cn(
              "w-[80%] min-w-0 shrink-0 snap-start md:w-auto",
              copy.plan === RECOMMENDED_PLAN && "order-first md:order-none",
            )}
          >
            <PlanCard
              copy={copy}
              offer={copy.plan === "pro" ? offer : null}
              pending={checkout.pendingPlan === copy.plan}
              busy={checkout.pendingPlan !== null}
              onPick={() => checkout.start(copy.plan)}
            />
          </div>
        ))}
      </div>

      <div className="mt-5 text-right">
        <button
          type="button"
          onClick={onSkipPro}
          className="text-[15px] text-foreground/70 underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          {t("continueFree")}
        </button>
      </div>
    </div>
  );
}

function PlanCard({
  copy,
  offer,
  pending,
  busy,
  onPick,
}: {
  copy: PlanCopy;
  offer: IntroOffer | null;
  pending: boolean;
  busy: boolean;
  onPick: () => void;
}) {
  const t = useTranslations("onboarding.plans");
  const recommended = copy.plan === RECOMMENDED_PLAN;

  return (
    <TapedCard
      color={PLAN_CARD[copy.plan].color}
      // An open offer's sticker takes the tape's corner.
      tapeColor={offer ? undefined : PLAN_CARD[copy.plan].tapeColor}
      fill
      tapePosition="right"
      tapeClassName={recommended ? "onboarding-tape-shake" : undefined}
    >
      {offer ? (
        <OfferSticker offer={offer} tone="yellow" className="onboarding-sticker-shake absolute -top-4 -right-4 z-10" />
      ) : null}
      <div className="flex h-full flex-col p-6 md:p-7">
        <div className="flex items-center gap-2">
          <div className="text-[22px] font-semibold">{copy.name}</div>
          {recommended ? (
            <span className="rounded-full bg-ink px-2.5 py-0.5 text-[12px] font-semibold text-white">
              {t("bestValue")}
            </span>
          ) : null}
        </div>
        {offer ? (
          <IntroPrice offer={offer} />
        ) : (
          <div className="mt-4 flex items-baseline gap-1.5">
            <span className="text-[clamp(34px,4vw,44px)] leading-[0.95] font-semibold">{copy.amount}</span>
            <span className="text-[14px] font-semibold text-[#201715]/70">{copy.cadence}</span>
          </div>
        )}
        <p className="mt-4 text-[15px] leading-[1.5] text-[#1a1a1a]">{copy.body}</p>

        <div className="mt-5 grid gap-2.5">
          {copy.features.map((feature) => (
            <div key={feature.text} className="flex items-center gap-2.5 text-[14px] font-semibold text-[#1a1a1a]">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-white">
                <FeatureIcon kind={feature.kind} />
              </span>
              {feature.text}
            </div>
          ))}
        </div>

        {/* The buttons line up across the row whatever each card holds. */}
        <div className="mt-auto pt-7">
          <Button
            onClick={onPick}
            disabled={busy}
            className="h-11 w-full rounded-full px-6 text-[15px] bg-ink text-white hover:bg-ink/90"
          >
            {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            {offer ? t("getProOff", { percent: offer.percentOff }) : t("getPlan", { plan: copy.name })}
          </Button>
        </div>
      </div>
    </TapedCard>
  );
}

function FeatureIcon({ kind }: { kind: PlanFeature["kind"] }) {
  if (kind === "credits") {
    return <Sparkles size={13} />;
  }
  if (kind === "inherits") {
    return <ArrowLeft size={13} />;
  }
  return <Check size={14} />;
}

// The discounted price beside the struck-through one, and what it covers.
function IntroPrice({ offer }: { offer: IntroOffer }) {
  const t = useTranslations("onboarding.plans");
  const locale = useLocale();

  return (
    <>
      <div className="mt-4 flex items-baseline gap-3">
        <span className="text-[clamp(34px,4vw,44px)] leading-[0.95] font-semibold">
          {priceLabel(offer.introCents, locale)}
        </span>
        <span className="text-[20px] font-semibold text-[#201715]/40 line-through decoration-2">
          {priceLabel(offer.priceCents, locale)}
        </span>
      </div>
      <div className="mt-2.5 text-[13px] font-semibold text-[#201715]">
        {t("covers", { months: offer.months, price: priceLabel(offer.priceCents, locale) })}
      </div>
    </>
  );
}
