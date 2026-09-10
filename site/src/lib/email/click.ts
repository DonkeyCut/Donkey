import { createHmac, timingSafeEqual } from "node:crypto";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";
import { prisma } from "@/lib/prisma";

// A button in a promotion goes through this app first, so the send row learns
// it was followed. The link carries the row id and the destination, signed
// with an HMAC keyed by a domain-separated derivation of the auth secret, so
// nobody can mark rows clicked or bounce people to their own address.
const TOKEN_DOMAIN = "donkey-email-click-v1";

function signature(sendId: string, url: string): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set.");
  const key = createHmac("sha256", secret).update(TOKEN_DOMAIN).digest();
  return createHmac("sha256", key).update(`${sendId}\n${url}`).digest();
}

export function clickUrl(sendId: string, url: string): string {
  const params = new URLSearchParams({ s: sendId, u: url, t: signature(sendId, url).toString("base64url") });
  return `${DONKEYCUT_CANONICAL}/api/email/click?${params}`;
}

export function verifyClick(sendId: string, url: string, token: string): boolean {
  const expected = signature(sendId, url);
  const given = Buffer.from(token, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Stamps the row's first click; later clicks leave the first stamp. */
export async function recordClick(sendId: string): Promise<void> {
  await prisma.emailSend.updateMany({ data: { clickedAt: new Date() }, where: { clickedAt: null, id: sendId } });
}
