import { expect, test } from "bun:test";
import { SIGN_IN_RETURN_COOKIE, signInReturnPath } from "@/lib/signInReturn";
import { SETTINGS } from "@/lib/config/registry";
import { stubModule } from "@/lib/testing/stubModule";

await stubModule<typeof import("@/lib/prisma")>("@/lib/prisma", import.meta.url, {
  prisma: {
    settingOverride: { findUnique: async () => ({ value: { ...SETTINGS.chatgptApp.default, enabled: true } }) },
  } as never,
});
await stubModule<typeof import("@/lib/donkey-api-auth")>("@/lib/donkey-api-auth", import.meta.url, {
  getDonkeyAuthContext: async () => null,
});
const { authorize } = await import("@/clients/chatgpt/server/oauthRoutes");
const { CLIENT_ID, OAUTH_PATH } = await import("@/clients/chatgpt/server/config");
const { pkceChallenge } = await import("@/clients/chatgpt/server/oauthPolicy");

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
