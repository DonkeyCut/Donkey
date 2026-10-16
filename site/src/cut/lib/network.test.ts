import { describe, expect, test } from "bun:test";

import { fetchDropped } from "./network";

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
