import { expect, test } from "bun:test";
import { signInReturnCookie, signInReturnPath } from "@/lib/signInReturn";

const value = (cookie: string) => decodeURIComponent(cookie.split(";")[0].split("=")[1]);

test("the URL's callback wins over the remembered one", () => {
  const remembered = value(signInReturnCookie("/api/chatgpt/oauth/authorize?state=a"));
  expect(signInReturnPath("/app/p/1", remembered)).toBe("/app/p/1");
  expect(signInReturnPath(undefined, remembered)).toBe("/api/chatgpt/oauth/authorize?state=a");
});

test("only same-site paths come back from the cookie", () => {
  expect(signInReturnPath(undefined, "https://evil.example/x")).toBeUndefined();
  expect(signInReturnPath(undefined, "//evil.example/x")).toBeUndefined();
  expect(signInReturnPath(undefined, "/\\evil.example")).toBeUndefined();
  expect(signInReturnPath(undefined, undefined)).toBeUndefined();
});

test("clearing expires the cookie", () => {
  expect(signInReturnCookie(null)).toContain("Max-Age=0");
});
