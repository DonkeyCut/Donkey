import { expect, test } from "bun:test";
import { AUTH_ERROR_PATH, resumeAfterAuthError, signInReturnCookie, signInReturnPath } from "@/lib/signInReturn";

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

test("a failed provider callback lands on sign-in", () => {
  expect(AUTH_ERROR_PATH).toBe("/sign-in");
});

test("a signed-in visitor replaying a spent callback goes on to the app", () => {
  // Back from the app into Google's redirect replays a state already used.
  expect(resumeAfterAuthError("please_restart_the_process", "signed-in", "/app/p/1")).toBe("/app/p/1");
  expect(resumeAfterAuthError("please_restart_the_process", "signed-in", undefined)).toBe("/app");
});

test("a signed-out visitor stays on sign-in to try again", () => {
  expect(resumeAfterAuthError("please_restart_the_process", "signed-out", "/app")).toBeNull();
  expect(resumeAfterAuthError(undefined, "signed-in", "/app")).toBeNull();
});
