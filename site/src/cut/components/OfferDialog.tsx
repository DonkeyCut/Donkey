"use client";

// The face of a credit offer, whichever way it reached the person: a picture
// across the top, a title, a line of body, and one full-width button. The
// email's claim link and the offer in the top bar both open this, so an
// offer looks the same from anywhere. Every slot keeps its height whether
// or not it has words, so the card stands still as the offer is taken up.
import Image from "next/image";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useCutPlan } from "@/app/[locale]/cut/_components/landing/cutPricingPlans";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// One picture per kind of offer: a gift for credit that comes with Pro, coins
// for credit that is simply waiting to be claimed.
export const OFFER_BANNERS = {
  subscribe: "/cut/offer-banner.webp",
  credits: "/cut/credits-banner.webp",
} as const;
export type OfferBanner = keyof typeof OFFER_BANNERS;

const isOfferBanner = (value: unknown): value is OfferBanner =>
  typeof value === "string" && value in OFFER_BANNERS;

// Each picture decodes once per page; the card waits on it, so it never opens
// with an empty banner that fills in a beat later. A picture that fails to
// load still lets the card open.
const bannerLoads = new Map<OfferBanner, Promise<void>>();

/** Fetches and decodes an offer picture ahead of the card that shows it. */
export function preloadBanner(banner: OfferBanner): Promise<void> {
  let load = bannerLoads.get(banner);
  if (!load) {
    const img = document.createElement("img");
    img.src = OFFER_BANNERS[banner];
    load = img.decode().catch(() => undefined);
    bannerLoads.set(banner, load);
  }
  return load;
}

/** Whether the card's picture is ready to paint; a banner of the caller's
 * own is always ready. */
function useBannerReady(banner: OfferBanner | null): boolean {
  const [loaded, setLoaded] = useState<OfferBanner | null>(null);
  useEffect(() => {
    if (!banner) {
      return;
    }
    let live = true;
    void preloadBanner(banner).then(() => {
      if (live) {
        setLoaded(banner);
      }
    });
    return () => {
      live = false;
    };
  }, [banner]);
  return banner === null || loaded === banner;
}

/** An offer's words: the message, and the terms line under it. */
export type OfferCopy = { body: string; terms: string | null };

/** The offer card's words in the page's language: how long landed credit
 * lasts, the claim's message, and the Pro offer's. */
export function useOfferCopy() {
  const t = useTranslations("billing");
  const format = useFormatter();
  const pro = useCutPlan("pro");

  // How long the credit lasts once it lands; null when it keeps forever.
  const creditValidity = (offer: { expiresAt: string | null; lifetimeDays: number | null }): string | null => {
    if (offer.expiresAt) {
      const date = format.dateTime(new Date(offer.expiresAt), { day: "numeric", month: "long" });
      return t("offer.validThrough", { date });
    }
    if (offer.lifetimeDays !== null) {
      return t("offer.validFor", { days: offer.lifetimeDays });
    }
    return null;
  };

  // The credit that is waiting and the last day to take it, then how long it
  // lasts once taken.
  const claimOfferCopy = (offer: {
    credits: string;
    closesAt: string | null;
    lifetimeDays: number | null;
  }): OfferCopy => {
    const body = offer.closesAt
      ? t("offer.claimBodyBy", {
          credits: offer.credits,
          date: format.dateTime(new Date(offer.closesAt), { day: "numeric", month: "long", year: "numeric" }),
        })
      : t("offer.claimBody", { credits: offer.credits });
    const terms = offer.lifetimeDays !== null ? t("offer.claimTerms", { days: offer.lifetimeDays }) : null;
    return { body, terms };
  };

  // The Pro offer. The deadline is the countdown's, so the message leaves it
  // out.
  const subscribeOfferCopy = (offer: {
    credits: string;
    expiresAt: string | null;
    lifetimeDays: number | null;
  }): OfferCopy => {
    return {
      body: t("offer.subscribeBody", { credits: offer.credits, price: pro.price }),
      terms: creditValidity(offer),
    };
  };

  return { claimOfferCopy, creditValidity, subscribeOfferCopy };
}

/** What is left until a moment, as the countdown reads it: hours, then
 * two-digit minutes and seconds, the hours running past a day. */
export function countdownParts(closesAt: string, now: number): { hours: number; minutes: string; seconds: string } {
  const left = Math.max(0, Math.floor((Date.parse(closesAt) - now) / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  return {
    hours: Math.floor(left / 3600),
    minutes: two(Math.floor((left % 3600) / 60)),
    seconds: two(left % 60),
  };
}

/** The clock a countdown reads; one tick a second while it is on screen. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Countdown({ closesAt }: { closesAt: string }) {
  const t = useTranslations("billing.offer");
  const now = useNow();
  return (
    <span className="absolute top-3 left-3 rounded-md bg-foreground/85 px-3 py-1.5 text-sm font-medium tabular-nums text-background">
      {t("expiresIn", countdownParts(closesAt, now))}
    </span>
  );
}

export function OfferDialog({
  open,
  onOpenChange,
  banner,
  closesAt,
  title,
  body,
  terms,
  cta,
  secondary,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // A named picture, or a banner of the caller's own for a card that is not
  // selling credit.
  banner: OfferBanner | React.ReactNode;
  // The last moment the offer can be taken up; a countdown sits over the
  // picture while there is one.
  closesAt?: string | null;
  title: React.ReactNode;
  body: React.ReactNode;
  // The fine print under the message, on its own line. Null holds the line
  // empty while the terms load; left out, the card has no such line.
  terms?: React.ReactNode;
  // The one thing to do, full width.
  cta: React.ReactNode;
  // A quieter way out beneath it, when there is one.
  secondary?: React.ReactNode;
  error?: React.ReactNode;
}) {
  const ready = useBannerReady(isOfferBanner(banner) ? banner : null);
  return (
    <Dialog open={open && ready} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden rounded-lg bg-background p-0 sm:max-w-[28.8rem]"
      >
        <div className="relative">
          {isOfferBanner(banner) ? (
            <Image
              src={OFFER_BANNERS[banner]}
              alt=""
              className="aspect-[8/3] w-full object-cover"
              width={1584}
              height={672}
              unoptimized
              priority
            />
          ) : (
            banner
          )}
          {closesAt ? <Countdown closesAt={closesAt} /> : null}
        </div>
        <div className="flex flex-col gap-5 p-6">
          <DialogHeader className="gap-2">
            <DialogTitle className="text-2xl leading-tight font-medium tracking-tight">{title}</DialogTitle>
            <DialogDescription className="min-h-12 text-base leading-relaxed text-muted-foreground">
              {body}
            </DialogDescription>
            {terms === undefined ? null : (
              <p className="min-h-[1lh] text-base leading-relaxed text-muted-foreground">{terms}</p>
            )}
          </DialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {/* The buttons keep the 21rem column of the narrower card. */}
          <div className="mx-auto mt-5 flex w-full max-w-84 flex-col gap-2">
            {cta}
            <div className="min-h-8">{secondary}</div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The full-width button the card ends in. */
export function OfferButton(props: React.ComponentProps<typeof Button>) {
  return <Button size="lg" className="h-12 w-full rounded-md text-base font-semibold" {...props} />;
}

/** The quieter way out under the button. */
export function OfferDismiss(props: React.ComponentProps<typeof Button>) {
  return <Button variant="ghost" className="w-full text-muted-foreground" {...props} />;
}
