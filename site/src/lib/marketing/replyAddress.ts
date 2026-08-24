import { createHmac, timingSafeEqual } from "node:crypto";

import { OUTREACH_REPLY_HOST } from "@/cut/lib/hosts";

// Every outreach email replies to its own address, so an inbound message finds
// its row without matching on the sender — people answer from aliases, and
// forwarded mail arrives from somewhere else entirely. The row id is signed the
// same way unsubscribe tokens are (src/lib/email/unsubscribe.ts), under its own
// domain string, so a stranger cannot post into a thread by guessing an id.
const TOKEN_DOMAIN = "donkey-outreach-reply-v1";

// Local-part shape: `outreach+${outreachId}.${signature}`. The signature is
// truncated because a local part may be no longer than 64 octets and some
// servers enforce it; 96 bits is far more than a forger gets attempts at.
const LOCAL_PART = /^outreach\+([^.@]+)\.([A-Za-z0-9_-]+)$/;
const SIGNATURE_BYTES = 12;

function signature(outreachId: string): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not set.");
  }
  const key = createHmac("sha256", secret).update(TOKEN_DOMAIN).digest();
  return createHmac("sha256", key).update(outreachId).digest().subarray(0, SIGNATURE_BYTES);
}

export function outreachReplyAddress(outreachId: string): string {
  const sig = signature(outreachId).toString("base64url");
  return `outreach+${outreachId}.${sig}@${OUTREACH_REPLY_HOST}`;
}

/** The row id an inbound address names, or null when it is not one of ours. */
export function outreachIdFromReplyAddress(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0) {
    return null;
  }
  const host = address.slice(at + 1).toLowerCase();
  if (host !== OUTREACH_REPLY_HOST) {
    return null;
  }
  const match = LOCAL_PART.exec(address.slice(0, at));
  if (!match) {
    return null;
  }
  const [, outreachId, given] = match;
  const expected = signature(outreachId);
  const supplied = Buffer.from(given, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return null;
  }
  return outreachId;
}

// Mail arrives addressed in more than one field: `received_for` carries the
// envelope recipient, `to` what the sender typed. Take the first that verifies.
export function outreachIdFromRecipients(
  ...groups: (string[] | null | undefined)[]
): string | null {
  for (const group of groups) {
    for (const entry of group ?? []) {
      // Headers arrive as "Name <addr@host>" as often as a bare address.
      const angled = /<([^>]+)>/.exec(entry);
      const id = outreachIdFromReplyAddress((angled?.[1] ?? entry).trim());
      if (id) {
        return id;
      }
    }
  }
  return null;
}
