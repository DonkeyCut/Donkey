import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { unauthorizedResponse } from "@/lib/donkey-api-auth";
import {
  setMarketingUnsubscribed,
  verifyUnsubscribeToken,
} from "@/lib/email/unsubscribe";

const querySchema = z.object({ token: z.string().min(1).max(512) });

// Public exception to withDonkeyAuth (docs/guides/backend-apis.md): RFC 8058
// one-click unsubscribe arrives as a bare POST from the recipient's mail
// provider, with no session. The signed token in the URL is the authorization,
// and the /unsubscribe page posts here too.
export async function POST(request: NextRequest) {
  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return unauthorizedResponse();
  }
  const userId = verifyUnsubscribeToken(parsed.data.token);
  if (!userId) {
    return unauthorizedResponse();
  }
  await setMarketingUnsubscribed(userId, true);
  return NextResponse.json({ ok: true });
}
