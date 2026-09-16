import { expect, test } from "bun:test";
import { artifactLifecycle, artifactUsageBytes } from "./artifactPolicy";

test("derived playback and scratch are distinct from retained media", () => {
  for (const kind of ["preview", "card", "hls"]) expect(artifactLifecycle(kind)).toBe("derived");
  expect(artifactLifecycle("overlay")).toBe("scratch");
  for (const kind of ["media", "export", "library"]) expect(artifactLifecycle(kind)).toBe("retained");
});

test("converting a charged preview to a derived artifact refunds its previous bytes once", () => {
  const bytes = BigInt(100);
  expect(artifactUsageBytes(bytes, true, true) - artifactUsageBytes(bytes, true, false)).toBe(-bytes);
  expect(artifactUsageBytes(bytes, true, true) - artifactUsageBytes(bytes, true, true)).toBe(BigInt(0));
  expect(artifactUsageBytes(bytes, false, false)).toBe(BigInt(0));
});
