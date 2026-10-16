import { expect, test } from "bun:test";
import { exportsDockOpen } from "./exportsDockView";

test("the dock opens while work is in flight and rests closed once it settles", () => {
  // A dock full of finished files sits over the chat composer, so it opens
  // only while something renders or waits, unless the person chose otherwise.
  expect(exportsDockOpen(["done", "error"], null)).toBe(false);
  expect(exportsDockOpen(["done", "rendering"], null)).toBe(true);
  expect(exportsDockOpen(["queued"], null)).toBe(true);
  expect(exportsDockOpen(["done"], "open")).toBe(true);
  expect(exportsDockOpen(["running"], "closed")).toBe(false);
});
