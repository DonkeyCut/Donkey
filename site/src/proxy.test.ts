import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import nextConfig from "../next.config";
import { proxy } from "./proxy";

// skipProxyUrlNormalize supplies the original URL to the proxy at runtime.
function request(url: string, cookie = "", acceptLanguage = "") {
  const headers: Record<string, string> = { cookie, host: new URL(url).host };
  if (acceptLanguage) headers["accept-language"] = acceptLanguage;
  const req = new NextRequest(url, { headers });
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
    expect(res.headers.get("x-middleware-rewrite")).toBe(`${origin}/en/cut/app/p/example?view=timeline`);
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

test("public auth routes skip the /cut rewrite", async () => {
  const res = await proxy(request("http://127.0.0.1:3000/sign-in"));
  expect(res.headers.get("x-middleware-rewrite")).toBe("http://127.0.0.1:3000/en/sign-in");
});

test("a visitor is served in their browser's language at the same address", async () => {
  const res = await proxy(request("https://donkeycut.com/install", "", "ja-JP,ja;q=0.9,en;q=0.8"));
  expect(res.headers.get("location")).toBeNull();
  expect(res.headers.get("x-middleware-rewrite")).toBe("https://donkeycut.com/ja/install");
  // A detected language is not saved; only a language the visitor picks is.
  expect(res.headers.getSetCookie().join("\n")).not.toMatch(/NEXT_LOCALE/);
});

test("a picked language wins over the browser's", async () => {
  const res = await proxy(request("https://donkeycut.com/app/p/1", "NEXT_LOCALE=de", "ja"));
  expect(res.headers.get("x-middleware-rewrite")).toBe("https://donkeycut.com/de/cut/app/p/1");
  expect(res.headers.getSetCookie().join("\n")).not.toMatch(/NEXT_LOCALE/);
});

test("a regional or unsupported language resolves to a shipped one", async () => {
  const portuguese = await proxy(request("https://donkeycut.com/", "", "pt-PT,pt;q=0.9"));
  expect(portuguese.headers.get("x-middleware-rewrite")).toBe("https://donkeycut.com/pt-BR/cut/usd");
  const chinese = await proxy(request("https://donkeycut.com/", "", "zh"));
  expect(chinese.headers.get("x-middleware-rewrite")).toBe("https://donkeycut.com/zh-CN/cut/usd");
  const dutch = await proxy(request("https://donkeycut.com/", "", "nl-NL"));
  expect(dutch.headers.get("x-middleware-rewrite")).toBe("https://donkeycut.com/en/cut/usd");
});

test("the landing prices in the visitor's country's currency", async () => {
  const brazil = request("https://donkeycut.com/", "", "pt-BR");
  brazil.headers.set("x-vercel-ip-country", "BR");
  expect((await proxy(brazil)).headers.get("x-middleware-rewrite")).toBe("https://donkeycut.com/pt-BR/cut/brl");
  const poland = request("https://donkeycut.com/");
  poland.headers.set("x-vercel-ip-country", "PL");
  expect((await proxy(poland)).headers.get("x-middleware-rewrite")).toBe("https://donkeycut.com/en/cut/usd");
});

test("a currency segment typed into the address goes back to the landing", async () => {
  const res = await proxy(request("https://donkeycut.com/eur"));
  expect(res.status).toBe(308);
  expect(res.headers.get("location")).toBe("https://donkeycut.com/");
});

test("a crawler with no language gets English", async () => {
  const res = await proxy(request("https://donkeycut.com/blog/some-post"));
  expect(res.headers.get("x-middleware-rewrite")).toBe("https://donkeycut.com/en/cut/blog/some-post");
});

test("a share link opens in the visitor's language at the same address", async () => {
  const res = await proxy(request("https://donkeycut.com/s/abc", "NEXT_LOCALE=ko"));
  expect(res.headers.get("x-middleware-rewrite")).toBe("https://donkeycut.com/ko/cut/s/abc");
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
