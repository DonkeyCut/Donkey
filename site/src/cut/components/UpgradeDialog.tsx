"use client";

// The wall a free account meets at a paid limit: one project past the free
// count, or a request that ran out of credits. Both sell Pro. A Pro account
// that runs out is sent to buy credits.
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderPlus, Loader2, Zap } from "lucide-react";

import { CUT_PRO, useCutPro } from "@/app/[locale]/cut/_components/landing/cutPricingPlans";
import { useIntroTerms, wallBanner } from "@/cut/components/IntroOffer";
import { OfferButton, OfferDialog, OfferDismiss, preloadBanner } from "@/cut/components/OfferDialog";
import { useCutBase } from "@/cut/lib/nav";
import { onOperationFailure } from "@/cut/lib/operationFailure";
import { useUpgradeToPro } from "@/cut/lib/proUpgrade";
import { onUpgrade, openUpgrade, type UpgradeReason } from "@/cut/lib/upgrade";
import { track } from "@/lib/analytics";
import { creditCountLabel, creditsPerDollar } from "@/lib/credits/format-credits";
import { useAccountConfig } from "@/queries/accountConfig";
import { useIntroOffer, useProSubscription } from "@/queries/billing";

export function UpgradeDialog() {
  const [reason, setReason] = useState<UpgradeReason | null>(null);
  const config = useAccountConfig({ enabled: true });
  const creditsMode = config.data?.settings.outOfCreditsUpsell.mode ?? "off";

  useEffect(() => onUpgrade(setReason), []);

  // A request refused for credits raises the wall while the setting asks for
  // it; otherwise the inline notice where the request failed is the answer.
  useEffect(() => {
    if (creditsMode !== "dialog") {
      return;
    }
    return onOperationFailure((failure) => {
      if (failure.code === "insufficient_credits" || failure.code === "insufficient_credits_for_generation") {
        openUpgrade("credits");
      }
    });
  }, [creditsMode]);

  if (!reason) {
    return null;
  }
  return (
    <OpenDialog
      reason={reason}
      projectLimit={config.data?.settings.freeProjectLimit.projects ?? null}
      onClose={() => setReason(null)}
    />
  );
}

// Split so the billing reads only run while the dialog is up.
function OpenDialog({
  reason,
  projectLimit,
  onClose,
}: {
  reason: UpgradeReason;
  projectLimit: number | null;
  onClose: () => void;
}) {
  const t = useTranslations("billing");
  const locale = useLocale();
  const introTerms = useIntroTerms();
  const { price } = useCutPro();
  const pro = useProSubscription();
  const isPro = pro.data?.isActive === true;
  const intro = useIntroOffer({ enabled: pro.data?.isActive === false });
  const upgrade = useUpgradeToPro();
  const base = useCutBase();
  const router = useRouter();
  const ready = pro.isSuccess && (isPro || !intro.isPending);

  // Either picture may head the card: credits for a Pro account, the offer's
  // while an intro discount is open. Both load beside the billing reads.
  useEffect(() => {
    void preloadBanner("credits");
    void preloadBanner("subscribe");
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    track("upgrade_dialog_shown", { reason, pro: isPro, intro: intro.data?.percentOff ?? 0 });
  }, [ready, reason, isPro, intro.data]);

  // Held until the plan is known, so the card never opens on the wrong pitch.
  if (!ready) {
    return null;
  }

  const close = (open: boolean) => {
    if (!open) {
      onClose();
    }
  };

  if (isPro) {
    return (
      <OfferDialog
        open
        onOpenChange={close}
        banner="credits"
        title={t("upgrade.outOfCredits")}
        body={t("upgrade.proOutBody")}
        cta={
          <OfferButton
            onClick={() => {
              onClose();
              router.push(`${base}/settings`);
            }}
          >
            {t("buyCredits")}
          </OfferButton>
        }
        secondary={<OfferDismiss onClick={onClose}>{t("notNow")}</OfferDismiss>}
      />
    );
  }

  const offer = intro.data ?? null;
  const credits = creditCountLabel(CUT_PRO.monthlyDollars * creditsPerDollar, locale);
  const wall =
    reason === "projects"
      ? {
          icon: FolderPlus,
          title: t("upgrade.projectsTitle"),
          body: projectLimit
            ? t("upgrade.projectsBody", { count: projectLimit })
            : t("upgrade.projectsBodyStarter"),
        }
      : {
          icon: Zap,
          title: t("upgrade.outOfCredits"),
          // An open offer prices Pro on its terms line.
          body: offer
            ? t("upgrade.creditsBodyOffer", { credits })
            : t("upgrade.creditsBody", { credits, price }),
        };

  // The terms line: an open offer's terms, else the price on the projects
  // wall. The credits wall names the price in its message, so it has none.
  const terms = offer
    ? introTerms(offer)
    : reason === "projects"
      ? t("upgrade.proPrice", { price })
      : undefined;

  return (
    <OfferDialog
      open
      onOpenChange={close}
      banner={wallBanner(wall.icon, offer)}
      closesAt={offer?.endsAt}
      title={wall.title}
      body={wall.body}
      terms={terms}
      cta={
        <OfferButton disabled={upgrade.isPending} onClick={upgrade.start}>
          {upgrade.isPending && <Loader2 className="animate-spin" data-icon="inline-start" />}
          {t("upgradeToPro")}
        </OfferButton>
      }
      secondary={<OfferDismiss onClick={onClose}>{t("notNow")}</OfferDismiss>}
    />
  );
}
