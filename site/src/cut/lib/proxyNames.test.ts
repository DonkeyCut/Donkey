import { expect, test } from "bun:test";
import { isLightProxyName, lightProxyNameFor } from "./proxyNames";

/** Two masters that share a stem (clip.mov, clip.mp4) are different footage,
 * so their light proxies keep the whole master name apart. */
test("a light proxy is named after the whole master name", () => {
  expect(lightProxyNameFor("clip.mov")).toBe("clip.mov.light.mp4");
  expect(lightProxyNameFor("clip.mp4")).not.toBe(lightProxyNameFor("clip.mov"));
  expect(isLightProxyName("clip.mov.light.mp4")).toBe(true);
  expect(isLightProxyName("clip.mov.light-1.mp4")).toBe(true);
  expect(isLightProxyName("clip.proxy.mp4")).toBe(false);
});
