import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { revalidatePlanTerms } from "@/lib/billing/plan-terms-server";

// su writes the plan terms from a separate deployment, and a cache clears
// only from inside the app that holds it, so su posts here after each save.
// Deliberately not wrapped in withDonkeyAuth — the caller is a machine, not a
// session — and gated by the shared secret su already holds for the site's
// caches (the blog's revalidate route takes the same one).

const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVER_ERROR = 500;

/** Constant-time bearer check: a byte-by-byte `!==` would leak the secret's
 * length and prefix through timing. */
function authorized(header: string, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export async function POST(request: Request) {
  const secret = process.env.BLOG_REVALIDATE_SECRET;
  if (!secret) {
    return new Response("BLOG_REVALIDATE_SECRET is not set", { status: HTTP_SERVER_ERROR });
  }
  if (!authorized(request.headers.get("authorization") ?? "", secret)) {
    return new Response("Unauthorized", { status: HTTP_UNAUTHORIZED });
  }
  revalidatePlanTerms();
  return NextResponse.json({ ok: true });
}
