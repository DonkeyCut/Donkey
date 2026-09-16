import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import nextConfig from "../next.config";
import { proxy } from "./proxy";

// skipProxyUrlNormalize supplies the original URL to the proxy at runtime.
function request(url: string) {
  const req = new NextRequest(url, { headers: { host: new URL(url).host } });
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
