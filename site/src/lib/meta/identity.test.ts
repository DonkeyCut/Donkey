import { expect, test } from "bun:test";

import { metaCookies, UNTRACKED_PAGES } from "./identity";

const NOW = 1_760_000_000_000;

function jar(values: Record<string, string>) {
  return { get: (name: string) => (name in values ? { value: values[name] } : undefined) };
}

test("a first visit gets a browser id", () => {
  const set = metaCookies(new URL("https://donkeycut.com/"), jar({}), NOW, "new");
  expect(set).toHaveLength(1);
  expect(set[0].name).toBe("_fbp");
  expect(set[0].value).toMatch(/^fb\.1\.1760000000000\.\d{10}$/);
});

test("an ad click sets the click id, verbatim", () => {
  const url = new URL("https://donkeycut.com/?fbclid=IwAR2xYz-AbC");
  const set = metaCookies(url, jar({ _fbp: "fb.1.1.1234567890" }), NOW, "new");
  expect(set).toEqual([{ name: "_fbc", value: "fb.1.1760000000000.IwAR2xYz-AbC" }]);
});

test("the same click reloaded keeps its cookie", () => {
  const url = new URL("https://donkeycut.com/?fbclid=abc");
  const held = jar({ _fbc: "fb.1.1700000000000.abc", _fbp: "fb.1.1.1234567890" });
  expect(metaCookies(url, held, NOW, "new")).toEqual([]);
});

test("a new click replaces the old one", () => {
  const url = new URL("https://donkeycut.com/?fbclid=new");
  const held = jar({ _fbc: "fb.1.1700000000000.old", _fbp: "fb.1.1.1234567890" });
  expect(metaCookies(url, held, NOW, "new")).toEqual([{ name: "_fbc", value: "fb.1.1760000000000.new" }]);
});

test("a page view renews the ids the browser holds", () => {
  const url = new URL("https://donkeycut.com/p");
  const held = jar({ _fbc: "fb.1.1700000000000.abc", _fbp: "fb.1.1.1234567890" });
  expect(metaCookies(url, held, NOW, "renew")).toEqual([
    { name: "_fbp", value: "fb.1.1.1234567890" },
    { name: "_fbc", value: "fb.1.1700000000000.abc" },
  ]);
});

test("a malformed click id sets no cookie", () => {
  const held = jar({ _fbp: "fb.1.1.1234567890" });
  for (const click of ["a b", "x".repeat(501), "<script>"]) {
    const url = new URL(`https://donkeycut.com/?fbclid=${encodeURIComponent(click)}`);
    expect(metaCookies(url, held, NOW, "new")).toEqual([]);
  }
});

test("the editor, shared player, and unsubscribe page report no page views", () => {
  for (const path of ["/app", "/app/p/abc", "/s/token", "/cut/app/settings", "/unsubscribe"]) {
    expect(UNTRACKED_PAGES.test(path)).toBe(true);
  }
  for (const path of ["/", "/sign-up", "/blog/post", "/apps", "/install"]) {
    expect(UNTRACKED_PAGES.test(path)).toBe(false);
  }
});
