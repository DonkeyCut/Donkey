import { describe, expect, test } from "bun:test";

import { fetchDropped, throttleWait } from "./network";

describe("fetchDropped", () => {
  test("reads each browser's wording for a dropped request", () => {
    // Chrome, Safari, and Firefox when the connection goes mid-body.
    for (const message of ["Failed to fetch", "Load failed", "Error in input stream"]) {
      expect(fetchDropped(new TypeError(message))).toBe(true);
    }
  });

  test("leaves a server's answer alone", () => {
    expect(fetchDropped(new Error("Cut couldn't read this media (404)."))).toBe(false);
  });
});

describe("throttleWait", () => {
  const throttled = (headers: Record<string, string> = {}) => new Response(null, { status: 429, headers });

  test("waits as long as the answer asks, in seconds or until a date", () => {
    expect(throttleWait(throttled({ "Retry-After": "3" }))).toBe(3_000);
    const now = Date.parse("2026-10-28T10:00:00Z");
    expect(throttleWait(throttled({ "Retry-After": "Wed, 28 Oct 2026 10:00:05 GMT" }), now)).toBe(5_000);
  });

  test("waits out the firewall's window when the answer names no wait", () => {
    expect(throttleWait(throttled())).toBe(10_000);
  });

  test("answers null for anything but a throttle", () => {
    expect(throttleWait(new Response(null, { status: 403 }))).toBeNull();
    expect(throttleWait(new Response(null, { status: 206 }))).toBeNull();
  });
});
