import { expect, test } from "bun:test";
import { SU_NAV, suPublicPath, suSurfaceAt, suTabs } from "./nav";

test("server and browser paths render the same super-user navigation", () => {
  for (const surface of SU_NAV) {
    for (const page of suTabs(surface) ?? [surface]) {
      expect(suSurfaceAt(`/su${page.href}`)).toEqual(suSurfaceAt(page.href));
      expect(suSurfaceAt(page.href).surface).toBe(surface);
      expect(suSurfaceAt(page.href).page).toBe(page);
    }
  }
});

test("nested blog pages keep their surface and normalize only the route prefix", () => {
  expect(suSurfaceAt("/su/blog/post-id").surface.title).toBe("Blog");
  expect(suPublicPath("/su/blog")).toBe("/blog");
  expect(suPublicPath("/su/blog/post-id")).toBe("/blog/post-id");
  expect(suPublicPath("/su")).toBe("/");
  expect(suPublicPath("/support")).toBe("/support");
  expect(suPublicPath("/blog/su/post-id")).toBe("/blog/su/post-id");
});
