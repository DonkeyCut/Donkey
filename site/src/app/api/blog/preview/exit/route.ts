import { draftMode } from "next/headers";
import { NextResponse } from "next/server";

import { withDonkeyAuth } from "@/lib/donkey-api-auth";

// Leaves Draft Mode. Reached from the banner on a previewed draft by a plain
// anchor, since a prefetched link would clear the cookie before the click.
export const GET = withDonkeyAuth(async (request) => {
  (await draftMode()).disable();
  return NextResponse.redirect(new URL("/blog", request.url));
});
