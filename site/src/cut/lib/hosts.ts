// Cut is served from one production host, mapped by src/proxy.ts onto the
// real routes under /cut: donkeycut.com — marketing landing at "/", the app
// at "/app/…" (rewritten to /cut/app/…). Old cut.donkeyuse.com links are
// redirected to donkeycut.com at the edge (Cloudflare) and never reach this
// app.
//
// Local dev is deliberately absent from the set: localhost gets its own proxy
// branch that mirrors donkeycut.com (Cut at "/", Donkey Use under /use),
// keeping the session cookie same-origin on the one dev origin.
export const DONKEYCUT_HOSTS = new Set(["donkeycut.com", "www.donkeycut.com"]);

export const DONKEYCUT_CANONICAL = "https://donkeycut.com";

// Shared media is served from its own hostname by the Cut Worker's R2 binding
// (src/cut/worker/cf/media.ts), never by this app. The Worker claims it as a
// custom domain in wrangler.jsonc; change that route and this together.
export const CUT_MEDIA_HOST = "media.donkeycut.com";
export const CUT_MEDIA_ORIGIN = `https://${CUT_MEDIA_HOST}`;

function hostname(host: string | null | undefined): string {
  return host ? host.split(":")[0] : "";
}

export function isDonkeycutHost(host: string | null | undefined): boolean {
  return DONKEYCUT_HOSTS.has(hostname(host));
}

// Local dev serves Donkey Cut by default: the proxy gives localhost the same
// "/…" → "/cut/…" mapping as donkeycut.com, with Donkey Use reachable under
// /use (see src/proxy.ts).
export function isLocalHost(host: string | null | undefined): boolean {
  const name = hostname(host);
  return name === "localhost" || name === "127.0.0.1";
}

// The link base every in-app Cut href is built on (see src/cut/lib/nav.tsx).
// The hosted apex (donkeyuse.com) serves the Cut tree unrewritten at /cut/app.
export function cutAppBase(host: string | null | undefined): string {
  if (isDonkeycutHost(host) || isLocalHost(host)) return "/app";
  return "/cut/app";
}
