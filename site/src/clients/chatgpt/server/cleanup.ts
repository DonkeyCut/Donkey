import { prisma } from "@/lib/prisma";
import { chatgptConfig } from "@/clients/chatgpt/server/config";
import { revokeEditorSessions } from "@/clients/chatgpt/server/oauthTokens";

export async function cleanupConnections() {
  const config = await chatgptConfig();
  if (!config.enabled) {
    return Response.json({ skipped: true });
  }
  const dead = await prisma.chatgptGrant.findMany({
    where: { OR: [{ expiresAt: { lte: new Date() } }, { revokedAt: { not: null } }] },
    select: { id: true },
  });
  await revokeEditorSessions(dead.map((grant) => grant.id));
  const [grants, consent] = await Promise.all([
    prisma.chatgptGrant.deleteMany({
      where: {
        OR: [{ expiresAt: { lte: new Date() } }, { revokedAt: { not: null } }],
      },
    }),
    prisma.verification.deleteMany({
      where: {
        OR: [
          { identifier: { startsWith: "chatgpt-consent:" } },
          { identifier: "chatgpt-oidc-code" },
        ],
        expiresAt: { lte: new Date() },
      },
    }),
  ]);
  // Keep used refresh tokens until the family expires so replay still revokes it.
  const access = await prisma.chatgptToken.deleteMany({
    where: { kind: { in: ["access", "embed", "session"] }, expiresAt: { lte: new Date() } },
  });
  return Response.json({
    grants: grants.count,
    consent: consent.count,
    access: access.count,
  });
}
