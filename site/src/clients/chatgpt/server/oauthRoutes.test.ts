import { expect, test } from "bun:test";
import { SIGN_IN_RETURN_COOKIE, signInReturnPath } from "@/lib/signInReturn";
import { SETTINGS } from "@/lib/config/registry";
import { stubModule } from "@/lib/testing/stubModule";

// The consent challenge a signed-in person's page holds, keyed by its id.
const challenges = new Map<string, { id: string; identifier: string; value: string; expiresAt: Date }>();
let signedIn: { userId: string } | null = null;

await stubModule<typeof import("@/lib/prisma")>("@/lib/prisma", import.meta.url, {
  prisma: {
    settingOverride: { findUnique: async () => ({ value: { ...SETTINGS.chatgptApp.default, enabled: true } }) },
    verification: {
      findUnique: async ({ where }: { where: { id: string } }) => challenges.get(where.id) ?? null,
      deleteMany: async ({ where }: { where: { id: string } }) => ({ count: challenges.delete(where.id) ? 1 : 0 }),
    },
  } as never,
});
await stubModule<typeof import("@/lib/donkey-api-auth")>("@/lib/donkey-api-auth", import.meta.url, {
  getDonkeyAuthContext: async () => signedIn as never,
});
await stubModule<typeof import("@/clients/chatgpt/server/oauthTokens")>("@/clients/chatgpt/server/oauthTokens", import.meta.url, {
  createCode: async () => "issued-code",
});
const { authorize, consent } = await import("@/clients/chatgpt/server/oauthRoutes");
const { CLIENT_ID, OAUTH_PATH } = await import("@/clients/chatgpt/server/config");
const { pkceChallenge, tokenHash } = await import("@/clients/chatgpt/server/oauthPolicy");

const SEE_OTHER = 303;

// A signed-out person reaches sign-in, then opens the email form in a new tab.
test("a signed-out authorization survives a sign-in that drops the callback", async () => {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    resource: "https://donkeycut.com/api/chatgpt/mcp",
    scope: "openid email projects:read",
    state: "oauth_s_test",
    code_challenge_method: "S256",
    code_challenge: pkceChallenge("a".repeat(43)),
  });
  const response = await authorize(
    new Request(`https://donkeycut.com${OAUTH_PATH}/authorize?${query}`),
  );

  expect(response.status).toBe(SEE_OTHER);
  const signIn = new URL(response.headers.get("location")!);
  const authorizePath = `${OAUTH_PATH}/authorize?${query}`;
  expect(signIn.searchParams.get("callbackURL")).toBe(authorizePath);

  const cookie = response.headers.get("set-cookie")!;
  const remembered = cookie.match(new RegExp(`${SIGN_IN_RETURN_COOKIE}=([^;]+)`))![1];
  expect(signInReturnPath(undefined, decodeURIComponent(remembered))).toBe(authorizePath);
});

// chatgpt.com answers 503 to a callback reached through a redirected form
// POST and serves the same URL to a plain navigation, so consent hands the
// code over from a page.
test("consent hands the code to the callback with a plain navigation", async () => {
  const nonce = "n".repeat(43);
  const browserToken = "b".repeat(43);
  const authorization = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    resource: "https://donkeycut.com/api/chatgpt/mcp",
    scope: "openid email projects:read",
    state: "oauth_s_test",
    code_challenge_method: "S256",
    code_challenge: pkceChallenge("a".repeat(43)),
  };
  challenges.set(`chatgpt:${tokenHash(nonce)}`, {
    id: `chatgpt:${tokenHash(nonce)}`,
    identifier: "chatgpt-consent:user-1",
    value: JSON.stringify({ authorization, browserTokenHash: tokenHash(browserToken) }),
    expiresAt: new Date(Date.now() + 60_000),
  });
  signedIn = { userId: "user-1" };

  const response = await consent(
    new Request(`https://donkeycut.com${OAUTH_PATH}/authorize`, {
      method: "POST",
      headers: {
        origin: "https://donkeycut.com",
        "content-type": "application/x-www-form-urlencoded",
        cookie: `__Host-donkey-chatgpt-consent=${browserToken}`,
      },
      body: new URLSearchParams({ nonce, decision: "allow" }),
    }) as never,
  );
  signedIn = null;

  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  const refresh = (await response.text()).match(/http-equiv="refresh" content="0;url=([^"]+)"/)![1];
  const callback = new URL(refresh.replaceAll("&amp;", "&"));
  expect(callback.origin + callback.pathname).toBe(authorization.redirect_uri);
  expect(callback.searchParams.get("code")).toBe("issued-code");
  expect(callback.searchParams.get("state")).toBe("oauth_s_test");
  expect(callback.searchParams.get("iss")).toBe("https://donkeycut.com");
});
