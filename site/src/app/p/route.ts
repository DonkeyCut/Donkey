import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { clientIp } from "@/lib/client-ip";
import { checkInMemoryRateLimit } from "@/lib/inference/rate-limit";
import { META_LIVE, metaBrowser, trackMetaEvent } from "@/lib/meta/conversions";
import { UNTRACKED_PAGES } from "@/lib/meta/identity";

// The page view beacon. Public by design: a signed-out visitor landing from an
// ad is the view it exists for. It lives at a short first-party address on
// this host so the page reports through Donkey's own server, and it only
// reports pages on this host outside the untracked ones.
const bodySchema = z.object({ url: z.string().url().max(2048) }).strict();

// A person reads a page or two a second at most; past this, an address is
// scripting the beacon and its views stay out of the dataset.
const VIEWS_PER_MINUTE = 60;
const MINUTE_MS = 60_000;

const NO_CONTENT = 204;
const BAD_REQUEST = 400;
const TOO_MANY_REQUESTS = 429;

export async function POST(request: NextRequest) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: BAD_REQUEST });
  }

  const page = new URL(parsed.data.url);
  if (page.host !== request.headers.get("host") || UNTRACKED_PAGES.test(page.pathname)) {
    return NextResponse.json({ error: "Invalid request" }, { status: BAD_REQUEST });
  }

  // Previews and local dev report nothing, so they skip the session read too.
  if (!META_LIVE) {
    return new NextResponse(null, { status: NO_CONTENT });
  }

  const ip = clientIp(request.headers);
  const limit = checkInMemoryRateLimit({ key: `meta-view:${ip}`, limit: VIEWS_PER_MINUTE, windowMs: MINUTE_MS });
  if (!limit.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: TOO_MANY_REQUESTS });
  }

  // Meta gets the page without its query or fragment, which can carry
  // tokens and return addresses; the ad click rides the _fbc cookie.
  const session = await auth.api.getSession({ headers: request.headers });
  trackMetaEvent({
    browser: metaBrowser(request.headers),
    id: crypto.randomUUID(),
    name: "PageView",
    url: `${page.origin}${page.pathname}`,
    user: session?.user,
  });
  return new NextResponse(null, { status: NO_CONTENT });
}
