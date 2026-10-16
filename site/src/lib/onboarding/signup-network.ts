import { createHmac } from "node:crypto";

import { isValidIP, normalizeIP } from "@better-auth/core/utils/ip";

import { prisma } from "@/lib/prisma";

// The header the host puts the caller's address in, first entry first. Vercel
// sets it on every request, and better-auth reads the same one.
const FORWARDED_FOR = "x-forwarded-for";

// The block of IPv6 addresses one household or device is handed. Cycling
// addresses inside it still counts as one network.
const IPV6_NETWORK_PREFIX = 64;

const DAY_MS = 24 * 60 * 60 * 1000;

type NetworkLimit = { limit: number; windowDays: number };

/**
 * The network a signup came from, as a keyed hash so the table holds no
 * address. Null when the request carries no readable address.
 */
export function signupNetworkKey(headers: Headers): string | null {
  const ip = headers.get(FORWARDED_FOR)?.split(",")[0]?.trim();
  if (!ip || !isValidIP(ip)) {
    return null;
  }

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not set");
  }
  const network = normalizeIP(ip, { ipv6Subnet: IPV6_NETWORK_PREFIX });
  return createHmac("sha256", secret).update(network).digest("hex");
}

/**
 * Takes one of the network's signup grants, and says whether one was left. A
 * window opens at the network's first claim and runs `windowDays`; once it
 * holds `limit` claims, signups from that network get none until it lapses.
 * Each step is a guarded write, so two signups racing on one network can't
 * both take its last claim.
 */
export async function claimSignupGrant(
  networkKey: string,
  cap: NetworkLimit,
  now: Date = new Date(),
): Promise<boolean> {
  // The network's first signup opens its window.
  await prisma.signupNetwork.createMany({
    data: [{ networkKey, windowStart: now, claims: 0 }],
    skipDuplicates: true,
  });

  // A window older than `windowDays` starts over at this signup.
  const lapsedBefore = new Date(now.getTime() - cap.windowDays * DAY_MS);
  await prisma.signupNetwork.updateMany({
    where: { networkKey, windowStart: { lt: lapsedBefore } },
    data: { windowStart: now, claims: 0 },
  });

  // Take a claim while the window has room.
  const { count } = await prisma.signupNetwork.updateMany({
    where: { networkKey, claims: { lt: cap.limit } },
    data: { claims: { increment: 1 } },
  });
  return count === 1;
}
