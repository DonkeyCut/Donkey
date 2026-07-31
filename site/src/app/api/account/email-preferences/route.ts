import { NextResponse } from "next/server";
import { z } from "zod";

import {
  withDonkeyAuth,
  type DonkeyAuthenticatedRequest,
} from "@/lib/donkey-api-auth";
import {
  isMarketingUnsubscribed,
  setMarketingUnsubscribed,
} from "@/lib/email/unsubscribe";

export const dynamic = "force-dynamic";

export const GET = withDonkeyAuth(
  async (request: DonkeyAuthenticatedRequest) => {
    return NextResponse.json({
      marketingEmails: !(await isMarketingUnsubscribed(request.donkey.userId)),
    });
  },
);

const updateSchema = z.object({ marketingEmails: z.boolean() });

export const PUT = withDonkeyAuth(
  async (request: DonkeyAuthenticatedRequest) => {
    const parsed = updateSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }
    await setMarketingUnsubscribed(
      request.donkey.userId,
      !parsed.data.marketingEmails,
    );
    return NextResponse.json({ marketingEmails: parsed.data.marketingEmails });
  },
);
