import { expect, test } from "bun:test";
import { limitOAuthSource } from "@/clients/chatgpt/server/oauthRateLimit";
import { SETTINGS } from "@/lib/config/registry";

function requestFrom(address: string) {
  return new Request("https://donkeycut.com/api/chatgpt/oauth/token", {
    headers: { "x-vercel-forwarded-for": address },
  });
}

test("source abuse is isolated by address and endpoint", () => {
  const abusiveSource = requestFrom("192.0.2.1");
  expect(limitOAuthSource(abusiveSource, "token", 2)).toBeNull();
  expect(limitOAuthSource(abusiveSource, "token", 2)).toBeNull();
  const limited = limitOAuthSource(abusiveSource, "token", 2);
  expect(limited?.status).toBe(429);
  expect(Number(limited?.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(limitOAuthSource(requestFrom("192.0.2.2"), "token", 2)).toBeNull();
  expect(limitOAuthSource(abusiveSource, "revoke", 2)).toBeNull();
});

test("missing trusted addresses never share a catch-all bucket", () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const request = new Request("http://localhost/api/chatgpt/oauth/token", {
      headers: { "x-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.1" },
    });
    expect(limitOAuthSource(request, "token", 2)).toBeNull();
  }
});

test("existing app settings receive the source limit without losing enabled state", () => {
  const { oauthRequestsPerIpMinute, ...existing } = SETTINGS.chatgptApp.default;
  const parsed = SETTINGS.chatgptApp.schema.parse({
    ...existing,
    enabled: true,
  });
  expect(parsed.enabled).toBe(true);
  expect(parsed.oauthRequestsPerIpMinute).toBe(oauthRequestsPerIpMinute);
});
