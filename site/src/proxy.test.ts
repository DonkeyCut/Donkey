import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import nextConfig from "../next.config";
import { proxy } from "./proxy";

// skipProxyUrlNormalize supplies the original URL to the proxy at runtime.
function request(url: string, cookie = "") {
  const req = new NextRequest(url, { headers: { cookie, host: new URL(url).host } });
  Object.defineProperty(req, "url", { value: url });
  return req;
}

test("proxy receives the original server URL", () => {
  expect(nextConfig.skipProxyUrlNormalize).toBe(true);
});

for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "donkeycut.com"]) {
  test(`editor rewrite preserves ${host} and its query`, async () => {
    const origin = `${host === "donkeycut.com" ? "https" : "http"}://${host}`;
    const res = await proxy(request(`${origin}/app/p/example?view=timeline`));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBe(`${origin}/cut/app/p/example?view=timeline`);
  });
}

test("a direct legacy URL redirects once to the public editor route", async () => {
  const res = await proxy(request("http://127.0.0.1:3000/cut/app/p/example?view=timeline"));
  expect(res.status).toBe(308);
  expect(res.headers.get("location")).toBe("http://127.0.0.1:3000/app/p/example?view=timeline");
  const editor = await proxy(request(res.headers.get("location")!));
  expect(editor.status).toBe(200);
  expect(editor.headers.get("location")).toBeNull();
});

test("public auth routes pass through", async () => {
  const res = await proxy(request("http://127.0.0.1:3000/sign-in"));
  expect(res.headers.get("x-middleware-next")).toBe("1");
  expect(res.headers.get("x-middleware-rewrite")).toBeNull();
});

test("www canonicalizes to the product host", async () => {
  const res = await proxy(request("https://www.donkeycut.com/app/p/example"));
  expect(res.status).toBe(308);
  expect(res.headers.get("location")).toBe("https://donkeycut.com/app/p/example");
});

test("a landing from an ad gets Meta's ids as first-party cookies", async () => {
  const res = await proxy(request("https://donkeycut.com/?fbclid=abc"));
  const set = res.headers.getSetCookie().join("\n");
  expect(set).toMatch(/_fbp=fb\.1\.\d+\.\d{10};.*HttpOnly/);
  expect(set).toMatch(/_fbc=fb\.1\.\d+\.abc;.*HttpOnly/);
});

test("API calls set no Meta cookies", async () => {
  const res = await proxy(request("https://donkeycut.com/api/credits/balance"));
  expect(res.headers.getSetCookie()).toEqual([]);
});

test("the page view beacon passes through", async () => {
  const res = await proxy(request("https://donkeycut.com/p"));
  expect(res.headers.get("x-middleware-next")).toBe("1");
  expect(res.headers.get("x-middleware-rewrite")).toBeNull();
});

test("the page view beacon restarts the ids' 90 days", async () => {
  const res = await proxy(request("https://donkeycut.com/p", "_fbp=fb.1.1.1234567890; _fbc=fb.1.2.abc"));
  const set = res.headers.getSetCookie().join("\n");
  expect(set).toMatch(/_fbp=fb\.1\.1\.1234567890;.*Max-Age=7776000/);
  expect(set).toMatch(/_fbc=fb\.1\.2\.abc;.*Max-Age=7776000/);
});

test("a page a returning browser opens leaves its ids alone", async () => {
  const res = await proxy(request("https://donkeycut.com/", "_fbp=fb.1.1.1234567890"));
  expect(res.headers.getSetCookie()).toEqual([]);
});
