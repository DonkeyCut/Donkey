import assert from "node:assert/strict";
import { mock } from "bun:test";
import { chromium } from "playwright";
import type {
  DonkeyAuthenticatedRequest,
  DonkeyAuthHandler,
} from "@/lib/donkey-api-auth";
import { SETTINGS } from "@/lib/config/registry";

type ConsentChallenge = {
  id: string;
  identifier: string;
  value: string;
  expiresAt: Date;
};

// Run in its own process: these test doubles isolate the browser flow from accounts and storage.
const challenges = new Map<string, ConsentChallenge>();
const submittedOrigins: Array<string | null> = [];
let issuedCodes = 0;
let tokenExchanges = 0;
let revocations = 0;

const callbackServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("ChatGPT callback received"),
});
const appServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method === "POST") {
      submittedOrigins.push(request.headers.get("origin"));
      return consent(request as DonkeyAuthenticatedRequest);
    }
    return authorize(request);
  },
});
const issuer = appServer.url.origin;
const redirectUri = new URL("/callback", callbackServer.url).href;
const oauthPath = "/api/chatgpt/oauth";
const resource = `${issuer}/api/chatgpt/mcp`;
const config = {
  ...SETTINGS.chatgptApp.default,
  enabled: true,
  issuer,
  redirectUris: [redirectUri],
  requestsPerMinute: 2,
  oauthRequestsPerIpMinute: 2,
};

mock.module("@/clients/chatgpt/server/config", () => ({
  CLIENT_ID: "donkey-chatgpt",
  SCOPES: ["projects:read", "previews:render"],
  OAUTH_PATH: oauthPath,
  chatgptConfig: async () => config,
  resourceUrl: () => resource,
}));
mock.module("@/lib/donkey-api-auth", () => ({
  getDonkeyAuthContext: async () => ({ userId: "owner" }),
  withDonkeyAuth: (handler: DonkeyAuthHandler) => (request: Request) => {
    return handler(
      Object.assign(request, {
        donkey: { userId: "owner" },
      }) as DonkeyAuthenticatedRequest,
    );
  },
}));
mock.module("@/lib/prisma", () => ({
  prisma: {
    verification: {
      create: async ({ data }: { data: ConsentChallenge }) => {
        challenges.set(data.id, data);
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        challenges.get(where.id),
      deleteMany: async ({ where }: { where: { id?: string } }) => ({
        count: where.id && challenges.delete(where.id) ? 1 : 0,
      }),
    },
  },
}));
mock.module("@/clients/chatgpt/server/oauthTokens", () => ({
  createCode: async () => {
    issuedCodes++;
    return "test-authorization-code";
  },
  exchangeToken: async () => {
    tokenExchanges++;
    return { access_token: "fixture-access-token", token_type: "Bearer" };
  },
  revokeToken: async () => {
    revocations++;
  },
}));
const { authorize, consent, tokenEndpoint, revocationEndpoint } =
  await import("@/clients/chatgpt/server/oauthRoutes");
for (const [operation, endpoint] of [
  ["token", tokenEndpoint],
  ["revoke", revocationEndpoint],
] as const) {
  const request = (source: string | null, form: URLSearchParams) => {
    const headers = new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    if (source) headers.set("x-vercel-forwarded-for", source);
    return new Request(`${issuer}${oauthPath}/${operation}`, {
      method: "POST",
      headers,
      body: form,
    });
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const malformed = await endpoint(
      request("192.0.2.10", new URLSearchParams({ invalid: "request" })),
    );
    assert.equal(malformed.status, 400);
  }
  const throttled = await endpoint(
    request("192.0.2.10", new URLSearchParams({ invalid: "request" })),
  );
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get("Retry-After")) > 0);

  const validForm =
    operation === "token"
      ? new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "donkey-chatgpt",
          resource,
          code: "a".repeat(43),
          code_verifier: "b".repeat(43),
          redirect_uri: redirectUri,
        })
      : new URLSearchParams({
          client_id: "donkey-chatgpt",
          token: "c".repeat(43),
        });
  const otherSource = await endpoint(request("192.0.2.11", validForm));
  assert.equal(otherSource.status, 200);
  const local = await endpoint(request(null, validForm));
  assert.equal(local.status, 200);
}
assert.equal(tokenExchanges, 2);
assert.equal(revocations, 2);

const browser = await chromium.launch();

try {
  for (const decision of ["Connect", "Cancel"]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const authorizationUrl = new URL(`${oauthPath}/authorize`, issuer);
      authorizationUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: "donkey-chatgpt",
        redirect_uri: redirectUri,
        scope: "projects:read previews:render",
        state: "browser-consent-state",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
        resource,
      }).toString();
      await page.goto(authorizationUrl.href);

      // Reject a foreign Origin without consuming the pending consent.
      const nonce = await page.locator('input[name="nonce"]').inputValue();
      const rejected = await fetch(new URL(`${oauthPath}/authorize`, issuer), {
        method: "POST",
        headers: {
          Origin: callbackServer.url.origin,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `__Host-donkey-chatgpt-consent=${nonce}`,
        },
        body: new URLSearchParams({ nonce, decision: "allow" }),
      });
      assert.equal(rejected.status, 400);
      assert.equal(challenges.size, 1);

      await Promise.all([
        page.waitForURL((url) => url.origin === callbackServer.url.origin),
        page.getByRole("button", { name: decision, exact: true }).click(),
      ]);
      const callbackUrl = new URL(page.url());
      assert.equal(
        callbackUrl.searchParams.get("state"),
        "browser-consent-state",
      );
      assert.equal(callbackUrl.searchParams.get("iss"), issuer);
      assert.equal(submittedOrigins.at(-1), issuer);
      assert.equal(challenges.size, 0);
      if (decision === "Connect") {
        assert.equal(
          callbackUrl.searchParams.get("code"),
          "test-authorization-code",
        );
        assert.equal(callbackUrl.searchParams.has("error"), false);
      } else {
        assert.equal(callbackUrl.searchParams.get("error"), "access_denied");
        assert.equal(callbackUrl.searchParams.has("code"), false);
      }
    } finally {
      await context.close();
    }
  }
  assert.equal(issuedCodes, 1);
  console.log(
    "PASS: browser consent, cancellation, cross-origin callbacks, foreign-Origin rejection, and isolated OAuth rate limits.",
  );
} finally {
  await browser.close();
  appServer.stop(true);
  callbackServer.stop(true);
}
