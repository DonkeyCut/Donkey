"use client";

import { useEffect } from "react";
import { create } from "zustand";

import { offloadHostedMedia } from "./hostedBlobs";

// Donkey's hosted inference routes, called from the page with the user's
// session and credits (the one hosted carve-out on the otherwise local-only
// Cut page). Shared by media generation, prompt composition, and AI chat.

const CLIENT_ID = "donkey-cut";

const OUT_KEY = "cut-credits-out";

/** Whether the account balance is known to be empty: the last hosted call
 * bounced with a 402 that named no price. Set and cleared by `hostedPost` — the
 * single chokepoint for hosted calls — and persisted so a reload keeps the
 * composer's credits tab up until a call goes through again. */
export const useOutOfCredits = create<{ out: boolean }>(() => ({
  out: typeof window !== "undefined" && safeRead() === "1",
}));

function safeRead(): string | null {
  try {
    return localStorage.getItem(OUT_KEY);
  } catch {
    return null;
  }
}

function setOut(out: boolean) {
  useOutOfCredits.setState({ out });
  try {
    if (out) localStorage.setItem(OUT_KEY, "1");
    else localStorage.removeItem(OUT_KEY);
  } catch {
    // Storage blocked — the flag just won't survive a reload.
  }
}

/** The balance as the hosted routes last reported it, in dollars, as a
 * subscription. A charged call answers with the balance it left behind — in a
 * header, or in the terminal frame of a stream — so the top bar's credits
 * readout follows every call without a request of its own. `settled` counts
 * calls that answered with no balance, for which the readout asks the balance
 * route once the charge has had a moment to land. */
export const useHostedBalance = create<{ balance: string | null; settled: number }>(() => ({
  balance: null,
  settled: 0,
}));

export function reportBalance(balance: string | undefined) {
  if (balance === undefined) {
    useHostedBalance.setState((s) => ({ settled: s.settled + 1 }));
    return;
  }
  useHostedBalance.setState({ balance });
}

async function noteBalance(res: Response) {
  if (res.ok) {
    setOut(false);
    // A stream reports from its terminal frame; the header is on the rest.
    if (res.headers.get("Content-Type")?.startsWith("text/event-stream")) return;
    reportBalance(res.headers.get("X-Donkey-Credits-Remaining") ?? undefined);
    return;
  }
  if (res.status !== 402) return;
  // Two kinds of 402. An empty balance stops everything hosted and takes the
  // page out; a balance merely short of one flat-priced generation stops that
  // generation while chat and the metered calls keep working, so it leaves the
  // flag alone and the tile carries the message. The body is a few bytes and
  // the caller still gets an unread stream.
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  if (body?.error !== "insufficient_credits_for_generation") setOut(true);
}

// One re-check in flight at a time; focus/visibility events can fire together.
let rechecking: Promise<void> | null = null;

/** While flagged out, ask the balance route directly: a top-up happens on the
 * settings page, so waiting for the next hosted call would leave the credits
 * tab up after the user already paid. Any failure leaves the flag as is. */
export function recheckCredits(): Promise<void> {
  if (!useOutOfCredits.getState().out) return Promise.resolve();
  rechecking ??= hostedFetch("/api/credits/balance", { cache: "no-store" })
    .then(async (res) => {
      if (!res.ok) return;
      const body = (await res.json()) as { balanceMicros?: string };
      if (Number(body.balanceMicros ?? 0) > 0) setOut(false);
    })
    .catch(() => {})
    .finally(() => {
      rechecking = null;
    });
  return rechecking;
}

/** Keep the out-of-credits flag honest while a surface shows it: re-check on
 * mount and whenever the tab regains focus, so reloading credits in another
 * tab clears the composer's credits tab without a hosted call. */
export function useCreditsRecheck(): void {
  const out = useOutOfCredits((s) => s.out);
  useEffect(() => {
    if (!out) return;
    void recheckCredits();
    const onFocus = () => void recheckCredits();
    const onVisible = () => {
      if (document.visibilityState === "visible") void recheckCredits();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [out]);
}

// The hosted routes run as serverless functions behind a 4.5MB request-body
// limit the platform enforces at the edge: an oversized body is refused before
// the route runs, the upload resets mid-flight, and fetch rejects with a bare
// "Failed to fetch" that reads like the network died. Media never rides the body
// far enough to reach that: past the soft limit every picture and sound moves to
// storage and travels as a reference (hostedBlobs.ts). The hard limit stands
// behind that as a plain error, for a body that is large without being media.
const OFFLOAD_ABOVE_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A headless session's transport: an absolute origin and auth headers folded
 * into every hosted call. In the page this stays unbound; same-origin calls
 * carry the session cookie on their own. */
let session: { base: string; headers: Record<string, string> } | null = null;
export function bindHostedSession(base: string, headers: Record<string, string>) {
  session = { base: base.replace(/\/$/, ""), headers };
}

/** Fetch a hosted route through the bound session when one exists. Every
 * hosted-route call in lib code goes through here so a headless process
 * reaches the right server with its auth. */
export const hostedFetch = (path: string, init?: RequestInit): Promise<Response> =>
  fetch((session?.base ?? "") + path, {
    ...init,
    headers: { ...session?.headers, ...(init?.headers as Record<string, string> | undefined) },
  });

/** POST one of Donkey's hosted inference routes with the user's session. */
export const hostedPost = async (path: string, body: unknown, signal?: AbortSignal) => {
  let payload = JSON.stringify(body);
  if (payload.length > OFFLOAD_ABOVE_BYTES) {
    payload = JSON.stringify(await offloadHostedMedia(body, CLIENT_ID));
  }
  if (new Blob([payload]).size > MAX_BODY_BYTES) {
    throw new Error("That request carries too much attached media to send. Use fewer references.");
  }
  const res = await hostedFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-donkey-client-id": CLIENT_ID },
    body: payload,
    signal,
  });
  await noteBalance(res);
  return res;
};
