import { prisma } from "@/lib/prisma";
import { chatgptConfig } from "@/clients/chatgpt/server/config";

export async function cleanupConnections() {
  const config = await chatgptConfig();
  if (!config.enabled) {
    return Response.json({ skipped: true });
  }
  const [grants, consent] = await Promise.all([
    prisma.chatgptGrant.deleteMany({
      where: {
        OR: [{ expiresAt: { lte: new Date() } }, { revokedAt: { not: null } }],
      },
    }),
    prisma.verification.deleteMany({
      where: {
        identifier: { startsWith: "chatgpt-consent:" },
        expiresAt: { lte: new Date() },
      },
    }),
  ]);
  // Keep used refresh tokens until the family expires so replay still revokes it.
  const access = await prisma.chatgptToken.deleteMany({
    where: { kind: "access", expiresAt: { lte: new Date() } },
  });
  return Response.json({
    grants: grants.count,
    consent: consent.count,
    access: access.count,
  });
}
