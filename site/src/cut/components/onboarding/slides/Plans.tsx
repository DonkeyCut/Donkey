"use client";

import { Check } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { TapedCard } from "@/app/_components/landing/LandingPrimitives";
import { useCutPro } from "@/app/[locale]/cut/_components/landing/cutPricingPlans";
import { Button } from "@/components/ui/button";
import { priceLabel } from "@/cut/components/IntroOffer";
import { countdownParts, useNow } from "@/cut/components/OfferDialog";
import { useUpgradeToPro } from "@/cut/lib/proUpgrade";
import { useIntroOffer, type IntroOffer } from "@/queries/billing";

import "../onboarding.css";

// The sequence's last word: Pro is the offer, free is the default, and the
// benefits sit in the card so nobody has to take the price on faith. It's the
// landing's own Pro card — same taped coral frame, same ringed check bullets —
// so the offer looks the same wherever it's met. Checkout is the one the
// storage wall and the billing page start. While the intro offer is open the
// card prices the discount and counts down to its end.
export function PlansSlide({ onSkipPro }: { onSkipPro: () => void }) {
  const t = useTranslations("onboarding.plans");
  const plan = useCutPro();
  const pro = useUpgradeToPro();
  const offer = useIntroOffer().data ?? null;

  return (
    <div className="mx-auto w-full max-w-[520px]">
      <h2 className="text-center text-[clamp(24px,3vw,32px)] leading-[1.1] font-semibold tracking-[-0.02em]">
        {t("title")}
      </h2>
      <p className="mt-3 text-center text-[16px] text-foreground/70">
        {t("subtitle")}
      </p>

      <div className="mt-8">
        <TapedCard
          color="coral"
          tapeColor="yellow"
          tapePosition="right"
          tapeClassName="onboarding-tape-shake"
        >
          <div className="p-7 md:p-9">
            <div className="text-[22px] font-semibold">Pro</div>
            {offer ? (
              <IntroPrice offer={offer} />
            ) : (
              <>
                <div className="mt-4 text-[clamp(34px,4.4vw,48px)] leading-[0.95] font-semibold">
                  {plan.price}
                </div>
                <div className="mt-2.5 text-[13px] font-semibold text-[#201715]">
                  {t("forIndividuals")}
                </div>
              </>
            )}
            <p className="mt-5 text-[15px] leading-[1.55] text-[#1a1a1a]">
              {plan.body}
            </p>

            <div className="mt-6 grid gap-2.5">
              {plan.features.map((feature) => (
                <div
                  key={feature}
                  className="flex items-center gap-2.5 text-[14px] font-semibold"
                >
                  <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-white">
                    <Check size={14} />
                  </span>
                  {feature}
                </div>
              ))}
            </div>

            <Button
              onClick={pro.start}
              disabled={pro.isPending}
              className="mt-7 h-11 rounded-full bg-ink px-6 text-[15px] text-white hover:bg-ink/90"
            >
              {offer ? t("getProOff", { percent: offer.percentOff }) : t("getPro")}
            </Button>
          </div>
        </TapedCard>
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

// The discounted price beside the struck-through one, what it covers, and
// the time left to take it.
function IntroPrice({ offer }: { offer: IntroOffer }) {
  const t = useTranslations("onboarding.plans");
  const locale = useLocale();
  const now = useNow();

  return (
    <>
      <div className="mt-4 flex items-baseline gap-3">
        <span className="text-[clamp(34px,4.4vw,48px)] leading-[0.95] font-semibold">
          {priceLabel(offer.introCents, locale)}
        </span>
        <span className="text-[22px] font-semibold text-[#201715]/40 line-through decoration-2">
          {priceLabel(offer.priceCents, locale)}
        </span>
      </div>
      <div className="mt-2.5 text-[13px] font-semibold text-[#201715]">
        {t("covers", { months: offer.months, price: priceLabel(offer.priceCents, locale) })}
      </div>
      <div className="mt-4 inline-flex rounded-full bg-ink px-3 py-1 text-[12px] font-semibold text-white tabular-nums">
        {t("endsIn", { percent: offer.percentOff, ...countdownParts(offer.endsAt, now) })}
      </div>
    </>
  );
}
