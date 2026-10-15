import { NextResponse } from "next/server";

import { withDonkeyAuth } from "@/lib/donkey-api-auth";
import { loadCreditPriceSheet } from "@/lib/credits/price-sheet.server";

// What each flat-priced generation costs, read by the Generate buttons.
export const GET = withDonkeyAuth(async () => {
  return NextResponse.json(await loadCreditPriceSheet());
});
