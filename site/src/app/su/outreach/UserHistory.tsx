"use client";

import { useState } from "react";

import { formatBytes } from "@/lib/bytes";
import { formatUsdPlain } from "@/lib/credits/format-usd";
import { useAnalyticsRollup } from "@/queries/analytics";
import { type OutreachRow } from "@/queries/outreach";
import { useUserHistory, type UserHistory, type UserHistoryEmail } from "@/queries/userHistory";

// What the site has already given and sent one person: paid money, storage
// held, and one timeline of the offers that reached them, the credit that
// landed, and the mail that went out. Money comes from the analytics rollup
// every su page already holds; the rest is one read of the account's rows.

const GRANT_LABELS: Record<string, string> = {
  signup: "Signup bonus",
  manual_dollar: "Credit offer claimed",
  subscribe_bonus: "Subscribe bonus landed",
  stripe_topup: "Top-up",
  stripe_autoreload: "Auto reload",
  pro_subscription: "Pro allowance",
};

const OFFER_LABELS: Record<string, string> = {
  manual: "Credit offer",
  promotion_email: "Promotion offer",
  promotion_subscribe: "Promotion offer for subscribing",
  subscribe_bonus: "Subscribe bonus offered",
};

const EMAIL_LABELS: Record<string, string> = {
  promotion: "Promotion",
  "promotion-hand": "Promotion, sent by hand",
  outreach: "Note",
  "credit-offer": "Credit offer email",
  "credit-expiry": "Credit expiry notice",
  welcome: "Welcome",
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });

const dollars = (micros: string) => formatUsdPlain((Number(micros) / 1_000_000).toFixed(2));

type Event = {
  at: string;
  key: string;
  title: string;
  amount: string | null;
  notes: string[];
  tone: "landed" | "open" | "missed" | "plain";
};

// The three lists as one story, newest first. An offer says where it stands
// — claimed, still open, or missed — and a grant what is left of it. The
// email that carried an offer is part of the offer's row: when it went out,
// whether by hand, and whether the person clicked.
function timeline(history: UserHistory, now: number): Event[] {
  const events: Event[] = [];
  const emailsByOffer = new Map<string, UserHistoryEmail[]>();
  for (const email of history.emails) {
    if (!email.offerId) continue;
    emailsByOffer.set(email.offerId, [...(emailsByOffer.get(email.offerId) ?? []), email]);
  }
  for (const offer of history.offers) {
    const notes: string[] = [];
    const carriers = emailsByOffer.get(offer.id) ?? [];
    const sentAt = carriers[0]?.sentAt ?? offer.emailSentAt;
    if (sentAt) {
      notes.push(`emailed ${day(sentAt)}${carriers.some((email) => email.kind === "promotion-hand") ? " by hand" : ""}`);
    }
    const clickedAt = carriers.find((email) => email.clickedAt)?.clickedAt;
    if (clickedAt) notes.push(`clicked ${day(clickedAt)}`);
    let tone: Event["tone"] = "open";
    if (offer.claimedAt) {
      notes.push(`claimed ${day(offer.claimedAt)}`);
      tone = "landed";
    } else if (offer.closesAt && Date.parse(offer.closesAt) < now) {
      notes.push(`closed ${day(offer.closesAt)} unclaimed`);
      tone = "missed";
    } else if (offer.closesAt) {
      notes.push(`open until ${day(offer.closesAt)}`);
    } else {
      notes.push("open");
    }
    events.push({
      at: offer.createdAt,
      key: `offer:${offer.id}`,
      title: offer.promotion ? `${OFFER_LABELS[offer.kind] ?? offer.kind} · ${offer.promotion.name}` : (OFFER_LABELS[offer.kind] ?? offer.description ?? offer.kind),
      amount: formatUsdPlain(offer.dollars),
      notes,
      tone,
    });
  }
  for (const grant of history.grants) {
    const notes: string[] = [];
    const left = Number(grant.remainingDollars);
    const expired = grant.expiresAt !== null && Date.parse(grant.expiresAt) < now;
    if (left > 0 && !expired) notes.push(`${formatUsdPlain(grant.remainingDollars)} left`);
    if (grant.expiresAt) notes.push(`${expired ? "expired" : "expires"} ${day(grant.expiresAt)}`);
    if (grant.status !== "active") notes.push(grant.status);
    events.push({
      at: grant.createdAt,
      key: `grant:${grant.id}`,
      title: GRANT_LABELS[grant.source] ?? grant.description ?? grant.source,
      amount: formatUsdPlain(grant.dollars),
      notes,
      tone: "landed",
    });
  }
  for (const email of history.emails) {
    if (email.offerId && history.offers.some((offer) => offer.id === email.offerId)) continue;
    const subject = email.promotion?.subject ?? email.subject;
    events.push({
      at: email.sentAt,
      key: `email:${email.id}`,
      title: email.promotion
        ? `${EMAIL_LABELS[email.kind] ?? email.kind} · ${email.promotion.name}`
        : subject
          ? `${EMAIL_LABELS[email.kind] ?? email.kind} · ${subject}`
          : (EMAIL_LABELS[email.kind] ?? email.kind),
      amount: null,
      notes: email.clickedAt ? [`clicked ${day(email.clickedAt)}`] : [],
      tone: "plain",
    });
  }
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

const TONE: Record<Event["tone"], string> = {
  landed: "bg-emerald-500",
  open: "bg-sky-500",
  missed: "bg-muted-foreground/40",
  plain: "bg-muted-foreground/40",
};

export function UserHistoryPanel({ target }: { target: OutreachRow }) {
  const history = useUserHistory(target.userId);
  const rollup = useAnalyticsRollup();
  const rolled = rollup.data?.users.find((user) => user.id === target.userId);
  // The rollup's billing events name the payer by email; the window's charges
  // for this person are the ones with theirs.
  const charges = (rollup.data?.billing?.events ?? []).filter(
    (event) => event.email === target.email && event.kind !== "canceled" && event.amountMicros !== null,
  );
  // The moment the panel opened; offers and grants are read against it.
  const [now] = useState(() => Date.now());
  const events = history.data ? timeline(history.data, now) : [];

  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Fact label="Paid all-time" value={rolled?.fundedMicros ? dollars(rolled.fundedMicros) : "$0"} />
        <Fact label="Balance" value={formatUsdPlain(target.balance)} />
        <Fact
          label="Storage"
          value={history.data ? formatBytes(Number(history.data.storageBytes)) : formatBytes(Number(target.storageBytes))}
        />
        <Fact label="Joined" value={day(target.signedUpAt)} />
      </dl>

      {charges.length > 0 ? (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Payments in the analytics window</h3>
          <ul className="divide-y rounded-lg border">
            {charges.map((charge, i) => (
              <li className="flex items-center gap-3 px-3 py-1.5 text-sm" key={`${charge.objectId ?? i}`}>
                <span className="w-24 shrink-0 tabular-nums text-muted-foreground">{day(charge.day)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {charge.kind === "paid" ? "Paid" : "Declined"}
                  {charge.detail ? ` · ${charge.detail}` : ""}
                </span>
                <span className="tabular-nums">{dollars(charge.amountMicros!)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">Offers, credit and mail</h3>
        {history.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : history.isError ? (
          <p className="text-sm text-destructive">Couldn&apos;t read this account&apos;s history.</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing sent or granted yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {events.map((event) => (
              <li className="flex items-start gap-3 px-3 py-1.5 text-sm" key={event.key}>
                <span className="w-24 shrink-0 tabular-nums text-muted-foreground">{day(event.at)}</span>
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${TONE[event.tone]}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{event.title}</span>
                  {event.notes.length > 0 ? (
                    <span className="block text-xs text-muted-foreground">{event.notes.join(" · ")}</span>
                  ) : null}
                </span>
                {event.amount ? <span className="tabular-nums">{event.amount}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
