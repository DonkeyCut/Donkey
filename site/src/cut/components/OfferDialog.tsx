"use client";

// The face of a credit offer, whichever way it reached the person: a picture
// across the top, a title, a line of body, and one full-width button. The
// email's claim link and the offer in the top bar both open this, so an
// offer looks the same from anywhere.
import Image from "next/image";
import { useEffect, useState } from "react";
import { CUT_PRO } from "@/app/cut/_components/landing/cutPricingPlans";
import { Button } from "@/components/ui/button";
import { formatCreditExpiry } from "@/lib/credits/top-up";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// One picture per kind of offer: a gift for credit that comes with Pro, coins
// for credit that is simply waiting to be claimed.
export const OFFER_BANNERS = {
  subscribe: "/cut/offer-banner.webp",
  credits: "/cut/credits-banner.webp",
} as const;
export type OfferBanner = keyof typeof OFFER_BANNERS;

/** A day as the card names it: "September 30". */
export function offerDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "long" });
}

/** An offer's words: the message, and the terms line under it. */
export type OfferCopy = { body: string; terms: string | null };

/** How long the credit lasts once it lands, as the card says it; null when
 * it keeps forever. */
export function creditValidity(offer: { expiresAt: string | null; lifetimeDays: number | null }): string | null {
  if (offer.expiresAt) return `Extra credits are valid through ${offerDay(offer.expiresAt)}.`;
  if (offer.lifetimeDays !== null) return `Extra credits are valid for ${offer.lifetimeDays} days.`;
  return null;
}

/** The claim's words: the credit that is waiting and the last day to take it,
 * then how long it lasts once taken. */
export function claimOfferCopy(offer: { credits: string; closesAt: string | null; lifetimeDays: number | null }): OfferCopy {
  const by = offer.closesAt ? ` Claim them by ${formatCreditExpiry(new Date(offer.closesAt))}.` : "";
  return {
    body: `You have ${offer.credits} in AI credits.${by}`,
    terms: offer.lifetimeDays !== null ? `Once claimed, they’re valid for ${offer.lifetimeDays} days.` : null,
  };
}

/** The Pro offer's words. The deadline is the countdown's, so the message
 * leaves it out. */
export function subscribeOfferCopy(offer: {
  credits: string;
  expiresAt: string | null;
  lifetimeDays: number | null;
}): OfferCopy {
  return {
    body: `Subscribe to Pro for ${CUT_PRO.price} and get ${offer.credits} in extra AI credits.`,
    terms: creditValidity(offer),
  };
}

/** What is left until a moment, as the countdown reads it: hours, minutes
 * and seconds, the hours running past a day. */
export function countdownLabel(closesAt: string, now: number): string {
  const left = Math.max(0, Math.floor((Date.parse(closesAt) - now) / 1000));
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const seconds = left % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${hours}h ${two(minutes)}m ${two(seconds)}s`;
}

/** The clock the countdown reads; one tick a second while the card is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Countdown({ closesAt }: { closesAt: string }) {
  const now = useNow();
  return (
    <span className="absolute top-3 left-3 rounded-md bg-foreground/85 px-3 py-1.5 text-sm font-medium tabular-nums text-background">
      Offer expires in {countdownLabel(closesAt, now)}
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
  banner: OfferBanner;
  // The last moment the offer can be taken up; a countdown sits over the
  // picture while there is one.
  closesAt?: string | null;
  title: React.ReactNode;
  body: React.ReactNode;
  // The fine print under the message, on its own line.
  terms?: React.ReactNode;
  // The one thing to do, full width.
  cta: React.ReactNode;
  // A quieter way out beneath it, when there is one.
  secondary?: React.ReactNode;
  error?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] translate-y-0 gap-0 overflow-hidden rounded-lg bg-background p-0 sm:max-w-sm"
      >
        <div className="relative">
          <Image
            src={OFFER_BANNERS[banner]}
            alt=""
            className="aspect-[8/3] w-full object-cover"
            width={1584}
            height={672}
            priority
          />
          {closesAt ? <Countdown closesAt={closesAt} /> : null}
        </div>
        <div className="flex flex-col gap-5 p-6">
          <DialogHeader className="gap-2">
            <DialogTitle className="text-2xl leading-tight font-medium tracking-tight">{title}</DialogTitle>
            <DialogDescription className="min-h-12 text-base leading-relaxed text-muted-foreground">
              {body}
            </DialogDescription>
            {terms ? <p className="text-base leading-relaxed text-muted-foreground">{terms}</p> : null}
          </DialogHeader>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="mt-5 flex flex-col gap-2">
            {cta}
            {secondary}
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
