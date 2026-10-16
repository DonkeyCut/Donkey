import { expect, test } from "bun:test";
import { compatCoverOf, compatCovers, compatProxyNameFor, isLightProxyName, lightProxyNameFor } from "./proxyNames";

/** Two masters that share a stem (clip.mov, clip.mp4) are different footage,
 * so their light proxies keep the whole master name apart. */
test("a light proxy is named after the whole master name", () => {
  expect(lightProxyNameFor("clip.mov")).toBe("clip.mov.light.mp4");
  expect(lightProxyNameFor("clip.mp4")).not.toBe(lightProxyNameFor("clip.mov"));
  expect(isLightProxyName("clip.mov.light.mp4")).toBe(true);
  expect(isLightProxyName("clip.mov.light-1.mp4")).toBe(true);
  expect(isLightProxyName("clip.proxy.mp4")).toBe(false);
});

/** A compat proxy says in its name what it carries: VP9 picture in WebM, or
 * the master's picture with Opus sound in MP4. */
test("a compat proxy names what it covers", () => {
  expect(compatProxyNameFor("clip.mov", "video", false)).toBe("clip.mov.compat.webm");
  expect(compatProxyNameFor("clip.mov", "audio", true)).toBe("clip.mov.compat.light.mp4");
  expect(compatCoverOf("clip.mov.compat.webm")).toBe("video");
  expect(compatCoverOf("clip.mov.compat.light-1.mp4")).toBe("audio");
  expect(compatCoverOf("clip.mov.light.mp4")).toBeNull();
  expect(compatCoverOf("clip.proxy.mp4")).toBeNull();
  // A light compat proxy serves a heavy video's stream as well.
  expect(isLightProxyName("clip.mov.compat.light.webm")).toBe(true);
  expect(isLightProxyName("clip.mov.compat.webm")).toBe(false);
});

test("a VP9 compat proxy covers sound too", () => {
  expect(compatCovers("clip.mov.compat.webm", "audio")).toBe(true);
  expect(compatCovers("clip.mov.compat.mp4", "video")).toBe(false);
  expect(compatCovers("clip.proxy.mp4", "audio")).toBe(false);
});
