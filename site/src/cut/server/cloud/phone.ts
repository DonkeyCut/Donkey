// The account's link to the iOS app. Every request the app makes carries
// `x-donkey-cut-client: ios`; the first sighting writes a CutPhoneLink row and
// the desktop keys its mobile surfaces (Camera Roll, Notes) off that row.
import { prisma } from "@/lib/prisma";

export const PHONE_CLIENT_HEADER = "x-donkey-cut-client";

// Accounts whose link this process already refreshed recently, so the row is
// written about once an hour per server instead of once per request.
const seenAt = new Map<string, number>();
const SEEN_TTL_MS = 60 * 60 * 1000;

/** Record that this request came from the iOS app, when it did. Fire-and-forget:
 * the link is a convenience flag and never gates the request itself. */
export function notePhoneClient(req: Request, userId: string): void {
  if (req.headers.get(PHONE_CLIENT_HEADER) !== "ios") return;
  const last = seenAt.get(userId);
  const now = Date.now();
  if (last && now - last < SEEN_TTL_MS) return;
  // Sweep expired entries so the map stays bounded by accounts active within
  // the TTL. At most one sweep per account per hour.
  for (const [id, at] of seenAt) {
    if (now - at >= SEEN_TTL_MS) seenAt.delete(id);
  }
  seenAt.set(userId, now);
  void prisma.cutPhoneLink
    .upsert({
      where: { userId },
      create: { userId },
      update: {},
    })
    .catch(() => {
      seenAt.delete(userId);
    });
}

export const phoneApi = {
  async get(userId: string) {
    const row = await prisma.cutPhoneLink.findUnique({ where: { userId } });
    return Response.json({ linked: row != null });
  },
};
