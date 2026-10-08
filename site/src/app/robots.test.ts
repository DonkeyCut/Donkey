import { expect, test } from "bun:test";

import robots from "@/app/robots";
import { metadata as signIn } from "@/app/sign-in/page";
import { metadata as signUp } from "@/app/sign-up/page";
import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

// Google must crawl auth pages to read their indexing rules, including email
// login links and callbacks discovered through the editor.
test("auth pages are crawlable and excluded from search", () => {
  const { rules } = robots();
  expect(Array.isArray(rules)).toBe(false);
  if (Array.isArray(rules)) {
    throw new Error("Expected one crawler rule");
  }

  expect(rules.allow).toBe("/");
  for (const path of ["/sign-in", "/sign-up", "/sign-in?method=email&callbackURL=%2Fapp"]) {
    for (const blocked of [rules.disallow].flat()) {
      expect(blocked && path.startsWith(blocked)).toBeFalsy();
    }
  }

  expect(signIn.robots).toEqual({ index: false, follow: true });
  expect(signUp.robots).toEqual({ index: false, follow: true });
});

// Account data keeps its crawl boundary, and discovery stays on the public host.
test("robots keeps app and API exclusions and the canonical sitemap", () => {
  const { rules, sitemap } = robots();
  expect(rules).toMatchObject({ disallow: ["/api/", "/app/", "/unsubscribe"] });
  expect(sitemap).toBe(`${DONKEYCUT_CANONICAL}/sitemap.xml`);
});
