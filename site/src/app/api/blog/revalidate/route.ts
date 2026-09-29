import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { revalidateBlogLater, revalidateBlogNow } from "@/lib/blog/revalidate";

// The blog editor runs in the internal su app, a separate deployment. Its
// writes change rows this app's blog pages have cached, and a cache clears only
// from inside the app that holds it, so the editor posts here after each write.
// Deliberately not wrapped in withDonkeyAuth — the caller is a machine, not a
// session — and gated by a shared secret, like the job worker's callback.

// Publishing waits for the pages to render again, twelve tries apart.
export const maxDuration = 60;

const bodySchema = z.object({
  slugs: z.array(z.string().trim().min(1)),
  wait: z.boolean(),
});

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
    return new Response("BLOG_REVALIDATE_SECRET is not set", { status: 500 });
  }
  const authz = request.headers.get("authorization") ?? "";
  if (!authorized(authz, secret)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return new Response("Bad request", { status: 400 });
  }
  if (body.data.wait) await revalidateBlogNow(body.data.slugs);
  else revalidateBlogLater(body.data.slugs);
  return NextResponse.json({ ok: true });
}
