// Cut is served from one production host, mapped by src/proxy.ts onto the
// real routes under /cut: donkeycut.com — marketing landing at "/", the app
// at "/app/…" (rewritten to /cut/app/…). Retired domains are redirected to
// donkeycut.com at the edge (Cloudflare) and never reach this app.
//
// Local dev is deliberately absent from the set: the proxy serves localhost
// the same mapping, keeping the session cookie same-origin on the one dev
// origin.
export const DONKEYCUT_HOSTS = new Set(["donkeycut.com", "www.donkeycut.com"]);

export const DONKEYCUT_CANONICAL = "https://donkeycut.com";

// Shared media is served from its own hostname by the Cut Worker's R2 binding
// (src/cut/worker/cf/media.ts), never by this app. The Worker claims it as a
// custom domain in wrangler.jsonc; change that route and this together.
export const CUT_MEDIA_HOST = "media.donkeycut.com";
export const CUT_MEDIA_ORIGIN = `https://${CUT_MEDIA_HOST}`;

// Founder outreach replies land here: Resend receives mail for this subdomain
// and posts it to /api/email/resend-webhook. It is deliberately a subdomain —
// the MX record belongs to Resend, and the apex keeps whatever routes its mail
// today (src/lib/marketing/replyAddress.ts).
export const OUTREACH_REPLY_HOST = "reply.donkeycut.com";

// The Cut Worker's control plane — the /wake the hosted API posts to when it
// queues a render. Its own custom domain, claimed in wrangler.jsonc beside the
// media route, so it cannot be revoked by a deploy default the way the
// workers.dev address was: adding the media route turned workers.dev off and
// stranded every render for two days, with nothing to see but queued jobs.
export const CUT_WORKER_HOST = "worker.donkeycut.com";
export const CUT_WORKER_WAKE_URL = `https://${CUT_WORKER_HOST}/wake`;

// Where the worker's runner calls the hosted API back: production containers
// (NODE_ENV=production in the image) talk to the canonical host, a dev worker
// run by hand talks to the local dev server.
export const CUT_HOSTED_ORIGIN =
  process.env.NODE_ENV === "production" ? DONKEYCUT_CANONICAL : "http://localhost:3000";

function hostname(host: string | null | undefined): string {
  return host ? host.split(":")[0] : "";
}

export function isDonkeycutHost(host: string | null | undefined): boolean {
  return DONKEYCUT_HOSTS.has(hostname(host));
}

// Local dev serves Donkey Cut by default: the proxy gives localhost the same
// "/…" → "/cut/…" mapping as donkeycut.com (see src/proxy.ts).
export function isLocalHost(host: string | null | undefined): boolean {
  const name = hostname(host);
  return name === "localhost" || name === "127.0.0.1";
}
