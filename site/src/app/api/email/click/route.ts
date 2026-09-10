import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { unauthorizedResponse } from "@/lib/donkey-api-auth";
import { recordClick, verifyClick } from "@/lib/email/click";

const querySchema = z.object({
  s: z.string().min(1).max(64),
  t: z.string().min(1).max(512),
  u: z.url({ protocol: /^https?$/ }).max(2000),
});

// Public exception to withDonkeyAuth (docs/guides/backend-apis.md): the
// recipient of a promotion follows this link from their mail client, with no
// session. The signed token in the URL is the authorization; it binds the
// send row to the destination, and a bad one goes nowhere.
export async function GET(request: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success || !verifyClick(parsed.data.s, parsed.data.u, parsed.data.t)) {
    return unauthorizedResponse();
  }
  await recordClick(parsed.data.s);
  return NextResponse.redirect(parsed.data.u, 302);
}
