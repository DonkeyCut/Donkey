import { describe, expect, test } from "bun:test";

import { verifyClick } from "./click";
import { verifyUnsubscribeToken } from "./unsubscribe";

// The back office signs these links and this site checks them, so the token
// format is a contract between two repos. The same vectors sit in the back
// office's click.test.ts, which asserts it produces them: a change to the
// domain, the message layout or the encoding on either side fails there or
// here until both move.
process.env.BETTER_AUTH_SECRET = "test-secret";

const CLICK = {
  sendId: "send_1",
  url: "https://donkeycut.com/app?claim=abc",
  token: "hnO3dPvX8ZIT34FfaT73cRkObMS2B7wQcKvVv3DE3dQ",
};
const UNSUBSCRIBE = { userId: "user_1", token: "user_1.DdhcnCkxaz6OeRbHqKZO6hgdhXMF-nNWJtRWiLm69l8" };

describe("click links", () => {
  test("the back office's token verifies for its row and destination", () => {
    expect(verifyClick(CLICK.sendId, CLICK.url, CLICK.token)).toBe(true);
  });

  test("a changed row, destination or token fails", () => {
    expect(verifyClick("send_2", CLICK.url, CLICK.token)).toBe(false);
    expect(verifyClick(CLICK.sendId, "https://evil.example/", CLICK.token)).toBe(false);
    expect(verifyClick(CLICK.sendId, CLICK.url, "nope")).toBe(false);
  });
});

describe("unsubscribe links", () => {
  test("the back office's token names its account", () => {
    expect(verifyUnsubscribeToken(UNSUBSCRIBE.token)).toBe(UNSUBSCRIBE.userId);
  });

  test("a token for another account or with no signature fails", () => {
    expect(verifyUnsubscribeToken(UNSUBSCRIBE.token.replace("user_1.", "user_2."))).toBeNull();
    expect(verifyUnsubscribeToken("user_1")).toBeNull();
  });
});
