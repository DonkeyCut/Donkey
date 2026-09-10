import { describe, expect, test } from "bun:test";

import { clickUrl, verifyClick } from "./click";

process.env.BETTER_AUTH_SECRET ??= "test-secret";

describe("click links", () => {
  test("a link verifies for its own row and destination", () => {
    const url = new URL(clickUrl("send_1", "https://donkeycut.com/app?claim=abc"));
    const s = url.searchParams.get("s")!;
    const u = url.searchParams.get("u")!;
    const t = url.searchParams.get("t")!;
    expect(s).toBe("send_1");
    expect(u).toBe("https://donkeycut.com/app?claim=abc");
    expect(verifyClick(s, u, t)).toBe(true);
  });

  test("a changed row or destination fails", () => {
    const url = new URL(clickUrl("send_1", "https://donkeycut.com/app"));
    const t = url.searchParams.get("t")!;
    expect(verifyClick("send_2", "https://donkeycut.com/app", t)).toBe(false);
    expect(verifyClick("send_1", "https://evil.example/", t)).toBe(false);
    expect(verifyClick("send_1", "https://donkeycut.com/app", "nope")).toBe(false);
  });
});
