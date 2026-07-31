import { createHmac, timingSafeEqual } from "node:crypto";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { getResend, isResendConfigured } from "@/lib/email/resend";
import { prisma } from "@/lib/prisma";

// Unsubscribe links authenticate with an HMAC over the userId, keyed by a
// domain-separated derivation of the auth secret — possession of a valid token
// is the authorization. Tokens never expire: the link in an old email keeps
// working for as long as the account exists.
const TOKEN_DOMAIN = "donkey-email-unsubscribe-v1";

function signature(userId: string): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not set.");
  }
  const key = createHmac("sha256", secret).update(TOKEN_DOMAIN).digest();
  return createHmac("sha256", key).update(userId).digest();
}

// Token format: `${userId}.${base64url(hmac(userId))}`.
export function unsubscribeToken(userId: string): string {
  return `${userId}.${signature(userId).toString("base64url")}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const userId = token.slice(0, dot);
  const expected = signature(userId);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  return userId;
}

// The page a human opens from an email footer.
export function unsubscribePageUrl(userId: string): string {
  return `${DONKEYCUT_CANONICAL}/unsubscribe?token=${unsubscribeToken(userId)}`;
}

// The endpoint mail providers POST to for RFC 8058 one-click unsubscribe.
export function unsubscribeActionUrl(userId: string): string {
  return `${DONKEYCUT_CANONICAL}/api/email/unsubscribe?token=${unsubscribeToken(userId)}`;
}

type SetUnsubscribedOptions = {
  // The Resend webhook passes false: the change came from Resend, so echoing
  // it back would loop.
  mirrorToResend?: boolean;
};

// The database row is authoritative; the Resend contact mirror is best-effort,
// so a Resend outage can never block the user's choice. A missing user (deleted
// account, dev-bypass caller) is a quiet no-op — unsubscribing is idempotent by
// contract.
export async function setMarketingUnsubscribed(
  userId: string,
  unsubscribed: boolean,
  { mirrorToResend = true }: SetUnsubscribedOptions = {},
): Promise<void> {
  const user = await prisma.user.findUnique({
    select: { email: true },
    where: { id: userId },
  });
  if (!user) {
    return;
  }

  const marketingUnsubscribedAt = unsubscribed ? new Date() : null;
  await prisma.userEmailSettings.upsert({
    create: { marketingUnsubscribedAt, userId },
    update: { marketingUnsubscribedAt },
    where: { userId },
  });

  if (!mirrorToResend || !isResendConfigured()) {
    return;
  }
  const { error } = await getResend().contacts.update({
    email: user.email,
    unsubscribed,
  });
  if (error) {
    console.error("[email] failed to mirror unsubscribe state to Resend", {
      error,
      userId,
    });
  }
}

// Gate for non-essential sends. Transactional and security email skips it;
// anything promotional must check it before sending.
export async function isMarketingUnsubscribed(userId: string): Promise<boolean> {
  const row = await prisma.userEmailSettings.findUnique({
    select: { marketingUnsubscribedAt: true },
    where: { userId },
  });
  return row?.marketingUnsubscribedAt != null;
}
