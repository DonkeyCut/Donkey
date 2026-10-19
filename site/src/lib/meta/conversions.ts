import { createHash } from "node:crypto";

import { parseCookies } from "better-auth/cookies";
import { after } from "next/server";

import { clientIp } from "@/lib/client-ip";
import { BROWSER_ID_COOKIE, CLICK_ID_COOKIE } from "@/lib/meta/identity";

// The Graph API version the Conversions API is called at. The dataset id and
// its token ride the environment.
const GRAPH_VERSION = "v26.0";

// Production deploys report; previews and local dev send nothing, so test
// traffic never trains the ad account.
export const META_LIVE = process.env.VERCEL_ENV === "production";

// Every event this site reports happens on the website.
const ACTION_SOURCE = "website";

// The browser an event came from, as Meta's matching wants it.
export type MetaBrowser = {
  ip?: string;
  userAgent?: string;
  fbp?: string;
  fbc?: string;
};

export type MetaEventName = "PageView" | "CompleteRegistration" | "InitiateCheckout" | "Purchase";

export type MetaEvent = {
  name: MetaEventName;
  // Meta drops a second event with the same name and id, so a retried
  // webhook reports once. For example "signup-<userId>".
  id: string;
  url: string;
  browser: MetaBrowser;
  user?: { id: string; email?: string | null };
  value?: { amount: number; currency: string };
  content?: string;
};

/**
 * Reports an event after the response is sent. A failure is logged and goes
 * no further: the signup or payment it describes has already happened.
 */
export function trackMetaEvent(event: MetaEvent): void {
  if (!META_LIVE) {
    return;
  }

  // after() throws outside a request (a script creating an account), which
  // is the same failure: log it and let the caller finish.
  try {
    after(async () => {
      try {
        await sendMetaEvent(event);
      } catch (error) {
        console.error("[meta] event not reported", { error, id: event.id, name: event.name });
      }
    });
  } catch (error) {
    console.error("[meta] event not reported", { error, id: event.id, name: event.name });
  }
}

/** The ids, address, and user agent of the browser behind a request. */
export function metaBrowser(headers: Headers): MetaBrowser {
  const cookies = parseCookies(headers.get("cookie") ?? "");
  return {
    fbc: cookies.get(CLICK_ID_COOKIE),
    fbp: cookies.get(BROWSER_ID_COOKIE),
    ip: clientIp(headers) ?? undefined,
    userAgent: headers.get("user-agent") ?? undefined,
  };
}

/**
 * Sends one event to the Conversions API. A test code routes it to the
 * dataset's Test events tab and keeps it out of reporting.
 */
export async function sendMetaEvent(event: MetaEvent, testCode?: string): Promise<void> {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!pixelId || !token) {
    throw new Error("META_PIXEL_ID and META_CAPI_ACCESS_TOKEN must both be set");
  }

  // The token rides the body so it stays out of request logs.
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events`, {
    body: JSON.stringify({ access_token: token, data: [serverEvent(event)], test_event_code: testCode }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Meta rejected ${event.name} (${res.status}): ${await res.text()}`);
  }
}

// The event in the Conversions API's shape. Email and account id leave
// hashed, as Meta requires; JSON drops the fields an event lacks.
function serverEvent(event: MetaEvent) {
  const { browser, user, value } = event;
  return {
    action_source: ACTION_SOURCE,
    custom_data: {
      content_name: event.content,
      currency: value?.currency.toUpperCase(),
      value: value?.amount,
    },
    event_id: event.id,
    event_name: event.name,
    event_source_url: event.url,
    event_time: Math.floor(Date.now() / 1000),
    user_data: {
      client_ip_address: browser.ip,
      client_user_agent: browser.userAgent,
      em: user?.email ? [sha256(user.email.trim().toLowerCase())] : undefined,
      external_id: user ? [sha256(user.id)] : undefined,
      fbc: browser.fbc,
      fbp: browser.fbp,
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
