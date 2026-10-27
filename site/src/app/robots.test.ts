import { expect, mock, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import { EN_MESSAGES } from "@/i18n/testing";

// The auth pages word their metadata through next-intl's server API, which
// reads the request's locale; here every read is English.
mock.module("next-intl/server", () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: "en", messages: EN_MESSAGES, namespace: namespace as never }),
}));

const robots = (await import("@/app/robots")).default;
const { generateMetadata: signInMetadata } = await import("@/app/[locale]/(public)/sign-in/page");
const { generateMetadata: signUpMetadata } = await import("@/app/[locale]/(public)/sign-up/page");
const { DONKEYCUT_CANONICAL } = await import("@/cut/lib/hosts");

// Google must crawl auth pages to read their indexing rules, including email
// login links and callbacks discovered through the editor.
test("auth pages are crawlable and excluded from search", async () => {
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

  const [signIn, signUp] = await Promise.all([signInMetadata(), signUpMetadata()]);
  expect(signIn.robots).toEqual({ index: false, follow: true });
  expect(signUp.robots).toEqual({ index: false, follow: true });
  expect(signIn.title).toBe("Log in | Donkey");
});

// Account data keeps its crawl boundary, and discovery stays on the public host.
test("robots keeps app and API exclusions and the canonical sitemap", () => {
  const { rules, sitemap } = robots();
  expect(rules).toMatchObject({ disallow: ["/api/", "/app/", "/unsubscribe"] });
  expect(sitemap).toBe(`${DONKEYCUT_CANONICAL}/sitemap.xml`);
});
