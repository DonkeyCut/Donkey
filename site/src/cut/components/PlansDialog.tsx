"use client";

// The plan ladder side by side: every wall that sells a plan — out of credits,
// the project limit, storage, the pill's Upgrade — opens this. Pro is marked
// the best value; the plan an account holds, and the ones under it, cannot
// be bought again.
import { useEffect, useRef } from "react";
import { ArrowLeft, Check, Loader2, Sparkles } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { useChargeCurrency } from "@/app/_components/ChargeCurrencyProvider";
import { useApiErrorText } from "@/app/[locale]/cut/app/(home)/settings/_components/useApiErrorText";
import { useCutPlans, type PlanCopy, type PlanFeature } from "@/app/[locale]/cut/_components/landing/cutPricingPlans";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OfferSticker } from "@/cut/components/OfferSticker";
import { usePlanCheckout } from "@/cut/lib/proUpgrade";
import type { UpgradeEntry } from "@/cut/lib/upgrade";
import { track } from "@/lib/analytics";
import { formatMinorPrice } from "@/lib/billing/format-price";
import { planRank, RECOMMENDED_PLAN, type PaidPlan } from "@/lib/billing/plans";
import { cn } from "@/lib/utils";
import { useIntroOffer, useProSubscription, type IntroOffer } from "@/queries/billing";

// The accent blue. The fill carries white text at 4.7:1; the light-theme text
// shade reads on white, the dark one on the dark popover.
const BLUE_FILL = "bg-[#0071e3] text-white hover:bg-[#0077ed]";
const BLUE_TEXT = "text-[#0062c4] dark:text-[#4aa3ff]";

export type PlansSource = "credits" | "projects" | "storage" | "plans";

export function PlansDialog({
  source,
  entry,
  title,
  body,
  notice,
  onClose,
}: {
  // What raised it, and the button or limit that did, for analytics.
  source: PlansSource;
  entry: UpgradeEntry;
  // The headline: one short line.
  title: React.ReactNode;
  // A small line under it, for the detail.
  body?: React.ReactNode;
  // A warning under the message, such as storage about to be reclaimed.
  notice?: React.ReactNode;
  onClose: () => void;
}) {
  const t = useTranslations("billing.plans");
  const tBilling = useTranslations("billing");
  const apiErrorText = useApiErrorText();
  const plans = useCutPlans();
  const charge = useChargeCurrency();
  const subscription = useProSubscription();
  const current = subscription.data?.plan ?? null;
  const intro = useIntroOffer({ enabled: subscription.data?.isActive === false });
  const checkout = usePlanCheckout({ surface: "plans_dialog", reason: source, entry });
  // Held until the plan and the currency are known, so no column opens
  // buyable and then locks, or repaints in another currency. A billing read
  // that fails still opens it, with the failure said, so a refusal is never
  // followed by nothing.
  const ready =
    subscription.isError ||
    (subscription.isSuccess && !charge.isPending && (current !== null || !intro.isPending));
  const error = checkout.error ?? subscription.error;

  // Opening focuses the card itself, so no plan's button starts out looking
  // picked; Tab moves into the plans.
  const popup = useRef<HTMLDivElement>(null);
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    if (!ready || shownAt.current !== null) {
      return;
    }
    shownAt.current = Date.now();
    track("upgrade_dialog_shown", {
      reason: source,
      entry,
      pro: current !== null,
      plan: current ?? "free",
      intro: intro.data?.percentOff ?? 0,
    });
  }, [ready, source, entry, current, intro.data]);

  // A close is a dismissal: a picked plan leaves the page for checkout.
  const close = () => {
    const seconds = shownAt.current === null ? 0 : Math.round((Date.now() - shownAt.current) / 1000);
    track("upgrade_dialog_closed", {
      reason: source,
      entry,
      plan: current ?? "free",
      intro: intro.data?.percentOff ?? 0,
      seconds,
    });
    onClose();
  };

  return (
    <Dialog open={ready} onOpenChange={(open) => !open && close()}>
      <DialogContent ref={popup} initialFocus={popup} className="gap-0 overflow-hidden p-0 sm:max-w-[60rem]">
        {/* A wash of the accent behind the heading. */}
        <div className="bg-gradient-to-b from-[#0071e3]/12 to-transparent px-6 pt-9 pb-7 text-center dark:from-[#0a84ff]/18 sm:px-10">
          <DialogHeader className="items-center gap-2">
            <DialogTitle className="text-2xl leading-tight font-semibold tracking-tight text-balance sm:text-[28px]">
              {title}
            </DialogTitle>
            {body ? (
              <DialogDescription className="max-w-xl text-base text-muted-foreground">{body}</DialogDescription>
            ) : null}
            {notice ? <p className="max-w-xl text-sm text-destructive">{notice}</p> : null}
          </DialogHeader>
        </div>
        <DialogBody className="mx-0 px-6 pt-1 pb-2 sm:px-10">
          <div className="grid gap-10 md:grid-cols-3 md:gap-0 md:divide-x md:divide-border">
            {plans.map((copy) => (
              <PlanColumn
                key={copy.plan}
                copy={copy}
                current={current}
                offer={copy.plan === "pro" ? (intro.data ?? null) : null}
                pendingPlan={checkout.pendingPlan}
                onPick={checkout.start}
              />
            ))}
          </div>
        </DialogBody>
        <div className="px-6 pt-5 pb-6 text-center text-xs text-muted-foreground sm:px-10">
          {error ? (
            <p className="mb-2 text-sm text-destructive">
              {apiErrorText(error, tBilling("billingUnavailable"))}
            </p>
          ) : null}
          {t("footer", { currency: charge.currency.toUpperCase() })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PlanColumn({
  copy,
  current,
  offer,
  pendingPlan,
  onPick,
}: {
  copy: PlanCopy;
  current: PaidPlan | null;
  // The intro discount, on the column it applies to.
  offer: IntroOffer | null;
  pendingPlan: PaidPlan | null;
  onPick: (plan: PaidPlan) => void;
}) {
  const t = useTranslations("billing.plans");
  const recommended = copy.plan === RECOMMENDED_PLAN;
  const held = planRank(copy.plan) <= planRank(current);

  return (
    <section className="relative flex flex-col md:px-7 md:first:pl-0 md:last:pr-0">
      {/* An open offer's sticker sits beside the heading, which makes room. */}
      {offer ? <OfferSticker offer={offer} tone="blue" className="absolute top-0 right-0 md:right-7" /> : null}
      <div className={cn("flex h-7 items-center gap-2", offer && "pr-24")}>
        <h3 className="text-lg font-semibold">{copy.name}</h3>
        {recommended ? (
          <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", BLUE_FILL)}>
            {t("bestValue")}
          </span>
        ) : null}
      </div>
      <p className={cn("mt-1 min-h-10 text-sm leading-snug text-muted-foreground", offer && "pr-24")}>{copy.body}</p>

      <Price copy={copy} offer={offer} />

      <PlanButton
        copy={copy}
        current={current}
        held={held}
        recommended={recommended}
        pending={pendingPlan === copy.plan}
        busy={pendingPlan !== null}
        onPick={onPick}
      />

      <ul className="mt-6 flex flex-col gap-3 text-sm">
        {copy.features.map((feature) => (
          <li key={feature.text} className="flex items-start gap-2.5">
            <FeatureIcon kind={feature.kind} accent={recommended} />
            <span className={cn(feature.kind === "credits" && "font-medium")}>{feature.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// The monthly price, large; an open intro offer shows its discounted first
// months beside the struck list price, and what follows them.
function Price({ copy, offer }: { copy: PlanCopy; offer: IntroOffer | null }) {
  const t = useTranslations("billing.plans");
  const locale = useLocale();
  return (
    <div className="mt-4">
      <div className="flex items-baseline gap-1.5">
        <span className="text-4xl font-semibold tracking-tight tabular-nums">
          {offer ? formatMinorPrice(offer.introMinor, offer.currency, locale) : copy.amount}
        </span>
        {offer ? (
          <span className="text-lg font-medium text-muted-foreground line-through tabular-nums">{copy.amount}</span>
        ) : null}
        <span className="text-sm text-muted-foreground">{copy.cadence}</span>
      </div>
      <div className={cn("mt-1 text-xs font-medium", offer ? BLUE_TEXT : "text-muted-foreground")}>
        {offer
          ? t("introThen", { months: offer.months, price: formatMinorPrice(offer.priceMinor, offer.currency, locale) })
          : t("billedMonthly")}
      </div>
    </div>
  );
}

function PlanButton({
  copy,
  current,
  held,
  recommended,
  pending,
  busy,
  onPick,
}: {
  copy: PlanCopy;
  current: PaidPlan | null;
  held: boolean;
  recommended: boolean;
  pending: boolean;
  busy: boolean;
  onPick: (plan: PaidPlan) => void;
}) {
  const t = useTranslations("billing.plans");
  const shape = "mt-5 h-11 w-full rounded-full text-[15px] font-semibold";

  // The plan held, or one under it: shown, never bought.
  if (held) {
    return (
      <Button
        variant="ghost"
        disabled
        className={cn(shape, "bg-muted/60 text-muted-foreground/70 disabled:opacity-100 dark:bg-muted/40")}
      >
        {copy.plan === current ? <Check data-icon="inline-start" /> : null}
        {copy.plan === current ? t("current") : t("get", { plan: copy.name })}
      </Button>
    );
  }

  return (
    <Button
      variant={recommended ? "default" : "outline"}
      disabled={busy}
      onClick={() => onPick(copy.plan)}
      className={cn(shape, recommended && BLUE_FILL)}
    >
      {pending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
      {current === null ? t("get", { plan: copy.name }) : t("upgrade", { plan: copy.name })}
    </Button>
  );
}

function FeatureIcon({ kind, accent }: { kind: PlanFeature["kind"]; accent: boolean }) {
  const tone = accent ? BLUE_TEXT : "text-muted-foreground";
  if (kind === "credits") {
    return <Sparkles className={cn("mt-0.5 size-4", accent ? BLUE_TEXT : "text-foreground")} />;
  }
  if (kind === "inherits") {
    return <ArrowLeft className="mt-0.5 size-4 text-muted-foreground" />;
  }
  return <Check className={cn("mt-0.5 size-4", tone)} />;
}
