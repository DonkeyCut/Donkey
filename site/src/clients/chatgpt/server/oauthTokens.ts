import type { ChatgptGrant, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CLIENT_ID,
  resourceUrl,
  type ChatgptConfig,
} from "@/clients/chatgpt/server/config";
import {
  newToken,
  pkceChallenge,
  sameSecret,
  tokenHash,
  type Authorization,
  type Exchange,
} from "@/clients/chatgpt/server/oauthPolicy";

import { enforceOAuthUserLimit } from "@/clients/chatgpt/server/oauthRateLimit";

/** The code and every rotated token belong to one revocable connection. */
export async function createCode(
  userId: string,
  authorization: Authorization,
  config: ChatgptConfig,
  db = prisma,
) {
  const code = newToken();
  await db.chatgptGrant.create({
    data: {
      userId,
      clientId: authorization.client_id,
      resource: authorization.resource,
      scope: authorization.scope,
      redirectUri: authorization.redirect_uri,
      challenge: authorization.code_challenge,
      expiresAt: new Date(Date.now() + config.refreshDays * 86_400_000),
      tokens: {
        create: {
          hash: tokenHash(code),
          kind: "code",
          expiresAt: new Date(Date.now() + 300_000),
        },
      },
    },
  });
  return code;
}

export async function exchangeToken(
  input: Exchange,
  config: ChatgptConfig,
  db = prisma,
) {
  if (input.resource !== resourceUrl(config)) {
    return null;
  }

  const isRefresh = input.grant_type === "refresh_token";
  const credential = isRefresh ? input.refresh_token : input.code;
  const expectedKind = isRefresh ? "refresh" : "code";
  const hash = tokenHash(credential);

  return db.$transaction(async (tx) => {
    const token = await tx.chatgptToken.findUnique({
      where: { hash },
      include: { grant: true },
    });
    if (!token || token.kind !== expectedKind) {
      return null;
    }

    const grant = token.grant;
    if (
      grant.clientId !== input.client_id ||
      grant.resource !== input.resource
    ) {
      return null;
    }
    if (grant.revokedAt || grant.expiresAt <= new Date()) {
      return null;
    }

    if (input.grant_type === "authorization_code") {
      if (grant.redirectUri !== input.redirect_uri) {
        return null;
      }
      if (!sameSecret(grant.challenge, pkceChallenge(input.code_verifier))) {
        return null;
      }
    } else if (input.scope !== undefined && input.scope !== grant.scope) {
      return null;
    }

    // Consumed hashes remain until the grant expires, so replay revokes the connection.
    if (token.consumedAt) {
      await tx.chatgptGrant.update({
        where: { id: grant.id },
        data: { revokedAt: new Date() },
      });
      return null;
    }
    if (token.expiresAt <= new Date()) {
      return null;
    }

    // Throttling leaves the credential usable when this user's window resets.
    enforceOAuthUserLimit(grant.userId, "token", config.requestsPerMinute);

    // Only one exchange can consume the credential, including concurrent requests.
    const consumed = await tx.chatgptToken.updateMany({
      where: { hash, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (!consumed.count) {
      await tx.chatgptGrant.update({
        where: { id: grant.id },
        data: { revokedAt: new Date() },
      });
      return null;
    }

    return issueTokenPair(tx, grant, config);
  });
}

async function issueTokenPair(
  tx: Prisma.TransactionClient,
  grant: Pick<ChatgptGrant, "id" | "scope" | "expiresAt">,
  config: ChatgptConfig,
) {
  const grantSecondsRemaining = Math.floor(
    (grant.expiresAt.getTime() - Date.now()) / 1000,
  );
  const accessSeconds = Math.min(config.accessSeconds, grantSecondsRemaining);
  if (accessSeconds <= 0) {
    return null;
  }

  const accessToken = newToken();
  const refreshToken = newToken();
  await tx.chatgptToken.createMany({
    data: [
      {
        hash: tokenHash(accessToken),
        grantId: grant.id,
        kind: "access",
        expiresAt: new Date(Date.now() + accessSeconds * 1000),
      },
      {
        hash: tokenHash(refreshToken),
        grantId: grant.id,
        kind: "refresh",
        expiresAt: grant.expiresAt,
      },
    ],
  });

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: accessSeconds,
    scope: grant.scope,
  };
}

export async function accessIdentity(
  bearer: string,
  config: ChatgptConfig,
  db = prisma,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(bearer)) {
    return null;
  }

  const token = await db.chatgptToken.findUnique({
    where: { hash: tokenHash(bearer) },
    include: { grant: true },
  });
  if (!token || token.kind !== "access" || token.expiresAt <= new Date()) {
    return null;
  }

  const grant = token.grant;
  if (grant.revokedAt || grant.expiresAt <= new Date()) {
    return null;
  }
  if (grant.clientId !== CLIENT_ID || grant.resource !== resourceUrl(config)) {
    return null;
  }

  return { userId: grant.userId, scopes: grant.scope.split(" "), grantId: grant.id };
}

export async function revokeToken(
  credential: string,
  config: ChatgptConfig,
  db = prisma,
) {
  const token = await db.chatgptToken.findUnique({
    where: { hash: tokenHash(credential) },
    select: { grantId: true, grant: { select: { userId: true } } },
  });
  if (!token) {
    return;
  }

  enforceOAuthUserLimit(token.grant.userId, "revoke", config.requestsPerMinute);

  await db.chatgptGrant.update({
    where: { id: token.grantId },
    data: { revokedAt: new Date() },
  });
  await revokeEditorSessions([token.grantId], db);
}

const EDITOR_CODE_SECONDS = 60;
const SESSION_REF = "session:";

/** A one-use code the card's frame redeems for an editor session. */
export async function createEditorCode(grantId: string, db = prisma) {
  const code = newToken();
  await db.chatgptToken.create({
    data: {
      hash: tokenHash(code),
      grantId,
      kind: "embed",
      expiresAt: new Date(Date.now() + EDITOR_CODE_SECONDS * 1000),
    },
  });
  return code;
}

export async function redeemEditorCode(
  code: string,
  config: ChatgptConfig,
  db = prisma,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
    return null;
  }
  const hash = tokenHash(code);
  const token = await db.chatgptToken.findUnique({
    where: { hash },
    include: { grant: true },
  });
  if (!token || token.kind !== "embed" || token.consumedAt || token.expiresAt <= new Date()) {
    return null;
  }
  const grant = token.grant;
  if (grant.revokedAt || grant.expiresAt <= new Date()) {
    return null;
  }
  if (grant.clientId !== CLIENT_ID || grant.resource !== resourceUrl(config)) {
    return null;
  }
  if (!grant.scope.split(" ").includes("projects:write")) {
    return null;
  }
  // One redemption: the request that marks the row first is the one it serves.
  const claimed = await db.chatgptToken.updateMany({
    where: { hash, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (claimed.count !== 1) {
    return null;
  }
  return { userId: grant.userId, grantId: grant.id };
}

/** The editor session a code produced, kept so revoking the connection ends it. */
export async function recordEditorSession(
  grantId: string,
  session: { id: string; expiresAt: Date },
  db = prisma,
) {
  await db.chatgptToken.create({
    data: { hash: `${SESSION_REF}${session.id}`, grantId, kind: "session", expiresAt: session.expiresAt },
  });
}

export async function revokeEditorSessions(grantIds: string[], db = prisma) {
  if (!grantIds.length) {
    return;
  }
  const rows = await db.chatgptToken.findMany({
    where: { grantId: { in: grantIds }, kind: "session" },
    select: { hash: true },
  });
  if (!rows.length) {
    return;
  }
  await db.session.deleteMany({
    where: { id: { in: rows.map((row) => row.hash.slice(SESSION_REF.length)) } },
  });
  await db.chatgptToken.deleteMany({
    where: { grantId: { in: grantIds }, kind: "session" },
  });
}
