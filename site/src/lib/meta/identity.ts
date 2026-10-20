// Meta matches a server-sent event to the person who saw an ad through two
// ids: the browser id (_fbp) and the ad click id (_fbc). Meta's own pixel
// script writes them from JavaScript, where Safari caps a cookie at seven
// days; this server writes them instead, as first-party cookies, and reads
// them back on every event it sends (conversions.ts). Edge-safe: the proxy
// imports this.

export const BROWSER_ID_COOKIE = "_fbp";
export const CLICK_ID_COOKIE = "_fbc";

// The query parameter Meta appends to an ad's landing URL, and the shape a
// real click id has. Anything else is ignored, so a crafted value never lands
// in a cookie that rides every request for 90 days.
const CLICK_ID_PARAM = "fbclid";
const CLICK_ID = /^[A-Za-z0-9_-]{1,500}$/;

// Meta's id format: "fb", the format version, the cookie's domain index (1 for
// an apex host like donkeycut.com), its creation time in ms, then the value.
// For example fb.1.1760000000000.1234567890.
const ID_PREFIX = "fb.1";

// Meta keeps the ids for 90 days after a browser's last page view.
export const META_COOKIE_MAX_AGE_S = 90 * 24 * 60 * 60;

// The first-party route every page view reports through (app/p/route.ts).
export const BEACON_PATH = "/p";

// The pages that never report a page view: the editor, the shared player, and
// the unsubscribe page, whose addresses carry project ids and tokens.
export const UNTRACKED_PAGES = /^\/(?:(?:cut\/)?(?:app|s)|unsubscribe)(?:\/|$)/;

type CookieValue = { name: string; value: string };

type CookieReader = { get(name: string): { value: string } | undefined };

// "new" writes only the ids a browser lacks. "renew" also writes back the ids
// it holds, so their 90 days restart; the page view beacon renews, page loads
// stay free of cookie headers for a returning browser.
export type MetaCookieScope = "new" | "renew";

/**
 * The id cookies a response sets: a browser id the first time a browser
 * arrives, and a click id whenever it lands from an ad with a click it has not
 * seen, plus the held ids when the scope renews them.
 */
export function metaCookies(url: URL, cookies: CookieReader, now: number, scope: MetaCookieScope): CookieValue[] {
  const set: CookieValue[] = [];

  const browserId = cookies.get(BROWSER_ID_COOKIE)?.value;
  if (!browserId) {
    set.push({ name: BROWSER_ID_COOKIE, value: `${ID_PREFIX}.${now}.${randomDigits()}` });
  } else if (scope === "renew") {
    set.push({ name: BROWSER_ID_COOKIE, value: browserId });
  }

  // A new ad click replaces the old one; the same click reloaded keeps its
  // first timestamp.
  const click = url.searchParams.get(CLICK_ID_PARAM);
  const held = cookies.get(CLICK_ID_COOKIE)?.value;
  if (click && CLICK_ID.test(click) && !held?.endsWith(`.${click}`)) {
    set.push({ name: CLICK_ID_COOKIE, value: `${ID_PREFIX}.${now}.${click}` });
  } else if (held && scope === "renew") {
    set.push({ name: CLICK_ID_COOKIE, value: held });
  }

  return set;
}

// Ten random digits, the browser id's random part.
function randomDigits(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String(n).padStart(10, "0");
}
