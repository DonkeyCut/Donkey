import { describe, expect, test } from "bun:test";
import type { prisma } from "@/lib/prisma";
import { SETTINGS } from "@/lib/config/registry";
import { CLIENT_ID, resourceUrl } from "@/clients/chatgpt/server/config";
import {
  authorizeInput,
  newToken,
  pkceChallenge,
  tokenHash,
  type Exchange,
  type Authorization,
} from "@/clients/chatgpt/server/oauthPolicy";
import {
  accessIdentity,
  createCode,
  createEditorCode,
  exchangeToken,
  recordEditorSession,
  redeemEditorCode,
  revokeToken,
} from "@/clients/chatgpt/server/oauthTokens";

const config = SETTINGS.chatgptApp.schema.parse({
  ...SETTINGS.chatgptApp.default,
  enabled: true,
});
const verifier = "a".repeat(43);
const input: Authorization = {
  response_type: "code" as const,
  client_id: CLIENT_ID,
  redirect_uri: config.redirectUris[0],
  resource: resourceUrl(config),
  scope: "projects:read previews:render",
  state: "opaque-state",
  code_challenge_method: "S256" as const,
  code_challenge: pkceChallenge(verifier),
};

type Grant = {
  id: string;
  userId: string;
  clientId: string;
  resource: string;
  scope: string;
  redirectUri: string;
  challenge: string;
  expiresAt: Date;
  revokedAt: Date | null;
};
type Token = {
  hash: string;
  grantId: string;
  kind: string;
  expiresAt: Date;
  consumedAt: Date | null;
};
function createTestContext() {
  const grants = new Map<string, Grant>(),
    tokens = new Map<string, Token>();
  const tx = {
    chatgptGrant: {
      create: async ({
        data,
      }: {
        data: Omit<Grant, "id" | "revokedAt"> & {
          tokens: { create: Omit<Token, "grantId" | "consumedAt"> };
        };
      }) => {
        const id = `grant-${grants.size}`;
        grants.set(id, { ...data, id, revokedAt: null });
        tokens.set(data.tokens.create.hash, {
          ...data.tokens.create,
          grantId: id,
          consumedAt: null,
        });
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { revokedAt: Date };
      }) => Object.assign(grants.get(where.id)!, data),
    },
    chatgptToken: {
      findUnique: async ({ where }: { where: { hash: string } }) => {
        const token = tokens.get(where.hash);
        return token
          ? { ...token, grant: { ...grants.get(token.grantId)! } }
          : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { hash: string };
        data: { consumedAt: Date };
      }) => {
        const token = tokens.get(where.hash);
        if (!token || token.consumedAt || token.expiresAt <= new Date()) {
          return { count: 0 };
        }
        Object.assign(token, data);
        return { count: 1 };
      },
      findMany: async ({ where }: { where: { grantId: { in: string[] }; kind: string } }) =>
        [...tokens.values()].filter((token) => where.grantId.in.includes(token.grantId) && token.kind === where.kind),
      deleteMany: async ({ where }: { where: { grantId: { in: string[] }; kind: string } }) => {
        let count = 0;
        for (const [hash, token] of tokens) {
          if (where.grantId.in.includes(token.grantId) && token.kind === where.kind) { tokens.delete(hash); count++; }
        }
        return { count };
      },
      createMany: async ({ data }: { data: Omit<Token, "consumedAt">[] }) => {
        for (const row of data) {
          tokens.set(row.hash, { ...row, consumedAt: null });
        }
      },
      create: async ({ data }: { data: Omit<Token, "consumedAt"> }) => {
        tokens.set(data.hash, { ...data, consumedAt: null });
      },
    },
  };
  const sessions = new Set<string>(["stray"]);
  const db = {
    ...tx,
    session: {
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        for (const id of where.id.in) sessions.delete(id);
        return { count: where.id.in.length };
      },
    },
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(tx),
  } as unknown as typeof prisma;
  const exchange = (
    code: string,
  ): Extract<Exchange, { grant_type: "authorization_code" }> => ({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    resource: input.resource,
    code,
    redirect_uri: input.redirect_uri,
    code_verifier: verifier,
  });
  return { db, grants, tokens, sessions, exchange };
}

describe("ChatGPT OAuth boundary", () => {
  test("authorization accepts only exact callbacks, resource, public client, and S256", () => {
    expect(authorizeInput(new URLSearchParams(input), config)).toEqual(input);
    for (const patch of [
      { redirect_uri: `${input.redirect_uri}/other` },
      { redirect_uri: `${input.redirect_uri}?next=https://attacker.test` },
      { resource: "https://attacker.test" },
      { client_id: "someone-else" },
      { code_challenge_method: "plain" },
      { scope: "projects:read admin" },
      { scope: "previews:render" },
      { state: "" },
    ]) {
      expect(
        authorizeInput(new URLSearchParams({ ...input, ...patch }), config),
      ).toBeNull();
    }
    const repeated = new URLSearchParams(input);
    repeated.append("redirect_uri", input.redirect_uri);
    expect(authorizeInput(repeated, config)).toBeNull();
  });
  test("PKCE matches the RFC 7636 vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
  test("wrong verifier and callback cannot consume a code; successful exchange stores only hashes", async () => {
    const { db, tokens, exchange } = createTestContext();
    const code = await createCode("owner", input, config, db);
    const valid = exchange(code);
    expect(
      await exchangeToken(
        { ...valid, code_verifier: "b".repeat(43) },
        config,
        db,
      ),
    ).toBeNull();
    expect(
      await exchangeToken(
        { ...valid, redirect_uri: "https://attacker.test" },
        config,
        db,
      ),
    ).toBeNull();
    const result = await exchangeToken(valid, config, db);
    expect(result?.scope).toBe(input.scope);
    expect(tokens.has(result!.access_token)).toBe(false);
    expect(tokens.has(tokenHash(result!.access_token))).toBe(true);
    expect(await accessIdentity(result!.access_token, config, db)).toEqual({
      userId: "owner",
      scopes: input.scope.split(" "),
      grantId: "grant-0",
    });
    expect(await accessIdentity(result!.refresh_token, config, db)).toBeNull();
  });
  test("an editor code is one use, needs write scope, and revoking the connection ends its session", async () => {
    const { db, tokens, sessions, exchange } = createTestContext();
    const code = await createCode("owner", { ...input, scope: "projects:read projects:write" }, config, db);
    const pair = (await exchangeToken(exchange(code), config, db))!;
    const identity = (await accessIdentity(pair.access_token, config, db))!;
    const editor = await createEditorCode(identity.grantId, db);
    expect(tokens.has(editor)).toBe(false);
    expect(await redeemEditorCode("nope", config, db)).toBeNull();
    expect(await redeemEditorCode(editor, config, db)).toEqual({ userId: "owner", grantId: identity.grantId });
    expect(await redeemEditorCode(editor, config, db)).toBeNull();
    await recordEditorSession(identity.grantId, { id: "sess", expiresAt: new Date(Date.now() + 60_000) }, db);
    sessions.add("sess");
    await revokeToken(pair.access_token, config, db);
    expect(sessions.has("sess")).toBe(false);
    expect(sessions.has("stray")).toBe(true);
    expect([...tokens.values()].some((token) => token.kind === "session")).toBe(false);

    const readOnly = createTestContext();
    const readCode = await createCode("owner", { ...input, scope: "projects:read" }, config, readOnly.db);
    const readPair = (await exchangeToken({ ...readOnly.exchange(readCode) }, config, readOnly.db))!;
    const readIdentity = (await accessIdentity(readPair.access_token, config, readOnly.db))!;
    const readEditor = await createEditorCode(readIdentity.grantId, readOnly.db);
    expect(await redeemEditorCode(readEditor, config, readOnly.db)).toBeNull();
  });
  test("code replay revokes tokens already issued by that code", async () => {
    const { db, exchange } = createTestContext();
    const code = await createCode("owner", input, config, db);
    const pair = await exchangeToken(exchange(code), config, db);
    expect(await exchangeToken(exchange(code), config, db)).toBeNull();
    expect(await accessIdentity(pair!.access_token, config, db)).toBeNull();
  });
  test("refresh rotation and replay revoke the entire family", async () => {
    const { db, exchange } = createTestContext();
    const code = await createCode("owner", input, config, db);
    const pair = (await exchangeToken(exchange(code), config, db))!;
    const refresh: Exchange = {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      resource: input.resource,
      refresh_token: pair.refresh_token,
    };
    const rotated = await exchangeToken(refresh, config, db);
    expect(rotated?.refresh_token === pair.refresh_token).toBe(false);
    expect(await exchangeToken(refresh, config, db)).toBeNull();
    expect(await accessIdentity(rotated!.access_token, config, db)).toBeNull();
  });
  test("resource substitution, expired tokens, and revocation deny access", async () => {
    const { db, exchange, tokens } = createTestContext();
    const code = await createCode("owner", input, config, db);
    expect(
      await exchangeToken(
        { ...exchange(code), resource: "https://attacker.test" },
        config,
        db,
      ),
    ).toBeNull();
    const pair = (await exchangeToken(exchange(code), config, db))!;
    expect(
      await accessIdentity(
        pair.access_token,
        { ...config, issuer: "https://another.test" },
        db,
      ),
    ).toBeNull();
    tokens.get(tokenHash(pair.access_token))!.expiresAt = new Date(0);
    expect(await accessIdentity(pair.access_token, config, db)).toBeNull();
    await revokeToken(pair.refresh_token, config, db);
    expect(
      await exchangeToken(
        {
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          resource: input.resource,
          refresh_token: pair.refresh_token,
        },
        config,
        db,
      ),
    ).toBeNull();
    expect(await accessIdentity(newToken(), config, db)).toBeNull();
  });
  test("concurrent code exchanges cannot both issue tokens", async () => {
    const { db, exchange } = createTestContext();
    const code = await createCode("owner", input, config, db);
    const results = await Promise.all([
      exchangeToken(exchange(code), config, db),
      exchangeToken(exchange(code), config, db),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

test("configuration rejects malformed or non-HTTPS issuer and callbacks without throwing", () => {
  for (const issuer of [
    "invalid",
    "http://donkeycut.com",
    "https://donkeycut.com/path",
    "https://donkeycut.com/",
  ]) {
    expect(
      SETTINGS.chatgptApp.schema.safeParse({ ...config, issuer }).success,
    ).toBe(false);
  }
  for (const redirect of [
    "invalid",
    "http://chatgpt.com/callback",
    "https://chatgpt.com/callback#fragment",
  ]) {
    expect(
      SETTINGS.chatgptApp.schema.safeParse({
        ...config,
        redirectUris: [redirect],
      }).success,
    ).toBe(false);
  }
});

describe("OAuth per-user limits", () => {
  const limitedConfig = { ...config, requestsPerMinute: 2 };

  test("invalid proof cannot exhaust a user's budget, and another user can still exchange", async () => {
    const { db, tokens, exchange } = createTestContext();
    const first = await createCode("limited-exchange-owner", input, config, db);
    const second = await createCode(
      "limited-exchange-owner",
      input,
      config,
      db,
    );
    const third = await createCode("limited-exchange-owner", input, config, db);
    const other = await createCode("other-exchange-owner", input, config, db);

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(
        await exchangeToken(
          { ...exchange(first), code_verifier: "wrong" },
          limitedConfig,
          db,
        ),
      ).toBeNull();
    }
    expect(
      await exchangeToken(exchange(first), limitedConfig, db),
    ).not.toBeNull();
    expect(
      await exchangeToken(exchange(second), limitedConfig, db),
    ).not.toBeNull();
    await expect(
      exchangeToken(exchange(third), limitedConfig, db),
    ).rejects.toThrow("OAuth request limit reached");
    expect(tokens.get(tokenHash(third))?.consumedAt).toBeNull();
    expect(
      await exchangeToken(exchange(other), limitedConfig, db),
    ).not.toBeNull();
  });

  test("rotation preserves the user budget and replay still revokes a throttled connection", async () => {
    const { db, tokens, exchange } = createTestContext();
    const code = await createCode("limited-refresh-owner", input, config, db);
    const pair = (await exchangeToken(exchange(code), limitedConfig, db))!;
    const refresh = (refreshToken: string): Exchange => ({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      resource: input.resource,
      refresh_token: refreshToken,
    });
    const rotated = (await exchangeToken(
      refresh(pair.refresh_token),
      limitedConfig,
      db,
    ))!;
    await expect(
      exchangeToken(refresh(rotated.refresh_token), limitedConfig, db),
    ).rejects.toThrow("OAuth request limit reached");
    expect(tokens.get(tokenHash(rotated.refresh_token))?.consumedAt).toBeNull();
    expect(
      await exchangeToken(refresh(pair.refresh_token), limitedConfig, db),
    ).toBeNull();
    expect(await accessIdentity(rotated.access_token, config, db)).toBeNull();
  });

  test("revocation has its own per-user budget and leaves a throttled grant unchanged", async () => {
    const { db, grants, tokens, exchange } = createTestContext();
    const first = await createCode("limited-revoke-owner", input, config, db);
    const second = await createCode("limited-revoke-owner", input, config, db);
    const third = await createCode("limited-revoke-owner", input, config, db);
    const other = await createCode("other-revoke-owner", input, config, db);

    await revokeToken(first, limitedConfig, db);
    await revokeToken(second, limitedConfig, db);
    await expect(revokeToken(third, limitedConfig, db)).rejects.toThrow(
      "OAuth request limit reached",
    );
    expect(
      grants.get(tokens.get(tokenHash(third))!.grantId)?.revokedAt,
    ).toBeNull();
    await revokeToken(other, limitedConfig, db);
    expect(
      grants.get(tokens.get(tokenHash(other))!.grantId)?.revokedAt,
    ).not.toBeNull();
    expect(
      await exchangeToken(exchange(third), limitedConfig, db),
    ).not.toBeNull();
  });
});
