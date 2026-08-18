import { NextResponse, type NextRequest } from "next/server";
import { Webhook } from "svix";
import { z } from "zod";

import { unauthorizedResponse } from "@/lib/donkey-api-auth";
import { setMarketingUnsubscribed } from "@/lib/email/unsubscribe";
import { prisma } from "@/lib/prisma";

// The one event this app consumes: an unsubscribe (or resubscribe) made on
// Resend's side — a broadcast footer link or a dashboard edit — flows back
// into the account's own preference row. Everything else acknowledges as a
// no-op so enabling more events in the dashboard never errors.
const contactUpdatedSchema = z.object({
  data: z.object({
    email: z.string().email(),
    unsubscribed: z.boolean(),
  }),
  type: z.literal("contact.updated"),
});

// Public exception to withDonkeyAuth (docs/guides/backend-apis.md): Resend
// calls this endpoint directly. Every request is Svix-signature-verified
// against RESEND_WEBHOOK_SECRET before it is read.
export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return unauthorizedResponse();
  }

  const payload = await request.text();
  let event: unknown;
  try {
    event = new Webhook(secret).verify(payload, {
      "svix-id": request.headers.get("svix-id") ?? "",
      "svix-signature": request.headers.get("svix-signature") ?? "",
      "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
    });
  } catch {
    return unauthorizedResponse();
  }

  const parsed = contactUpdatedSchema.safeParse(event);
  if (!parsed.success) {
    return NextResponse.json({ ok: true });
  }

  const user = await prisma.user.findUnique({
    select: { id: true },
    where: { email: parsed.data.data.email },
  });
  if (user) {
    await setMarketingUnsubscribed(user.id, parsed.data.data.unsubscribed, {
      mirrorToResend: false,
    });
  }
  return NextResponse.json({ ok: true });
}
