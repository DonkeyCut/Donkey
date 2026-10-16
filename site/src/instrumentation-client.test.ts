import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { bindFailureSink } from "./cut/lib/report";
import { stubModule } from "./lib/testing/stubModule";

type Event = { event: string; properties: { $exception_list: unknown[] } };
type BeforeSend = (event: Event) => Event | null;

let beforeSend: BeforeSend;
const saved = {
  env: { ...process.env },
  window: (globalThis as { window?: unknown }).window,
  document: (globalThis as { document?: unknown }).document,
};

// Load the client with production settings and keep the before_send it hands
// to posthog.init, so each case runs the real filter.
beforeAll(async () => {
  await stubModule("posthog-js", import.meta.url, {
    default: { init: (_key: string, config: { before_send: BeforeSend }) => (beforeSend = config.before_send) },
  } as never);
  Object.assign(process.env, { NEXT_PUBLIC_POSTHOG_KEY: "test", NODE_ENV: "production" });
  Object.assign(globalThis, { window: { location: { pathname: "/" }, addEventListener: () => {} } });
  await import("./instrumentation-client");
});

// Bun runs every test file in one process; put the environment back for the rest.
afterAll(() => {
  process.env = saved.env;
  Object.assign(globalThis, { window: saved.window, document: saved.document });
  // Loading the client bound Cut's failure reports to the stubbed PostHog.
  bindFailureSink((error) => console.error(error));
});

const translatedDocument = (lang: string, classes: string[]) => ({
  documentElement: { lang, classList: { contains: (c: string) => classes.includes(c) } },
});

const exception = (...list: unknown[]): Event => ({ event: "$exception", properties: { $exception_list: list } });

describe("before_send", () => {
  test("drops an opaque cross-origin script error", () => {
    const opaque = { type: "Error", value: "Script error.", mechanism: { synthetic: true } };

    expect(beforeSend(exception(opaque))).toBeNull();
  });

  test("drops the browser's ResizeObserver loop notice", () => {
    const notice = { type: "Error", value: "ResizeObserver loop completed with undelivered notifications." };

    expect(beforeSend(exception(notice))).toBeNull();
  });

  test("drops a wallet extension's injected script", () => {
    const wallet = {
      type: "TypeError",
      value: "undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')",
      stacktrace: { frames: [{ filename: "https://donkeycut.com/", function: "global code" }] },
    };

    expect(beforeSend(exception(wallet))).toBeNull();
  });

  test("drops a hydration error on a page the browser translated", () => {
    // Chrome's translator tags <html> and relabels its language.
    Object.assign(globalThis, { document: translatedDocument("pt", ["translated-ltr"]) });
    const hydration = { type: "Error", value: "Minified React error #418; visit <url> for the full message" };
    const moved = { type: "DOMException", value: "NotFoundError: Failed to execute 'insertBefore' on 'Node': x" };

    expect(beforeSend(exception(hydration))).toBeNull();
    expect(beforeSend(exception(moved))).toBeNull();
  });

  test("keeps a hydration error on the page as served", () => {
    Object.assign(globalThis, { document: translatedDocument("en", []) });
    const hydration = { type: "Error", value: "Minified React error #418; visit <url> for the full message" };

    expect(beforeSend(exception(hydration))).not.toBeNull();
  });

  test("drops a script the browser evaluated into the page", () => {
    // Chrome on iOS runs its translator inline; this one recursed until the
    // stack ran out, with every frame in the document itself.
    const translator = {
      type: "RangeError",
      value: "Maximum call stack size exceeded.",
      stacktrace: { frames: [{ filename: "/", lineno: 225 }, { filename: "/", lineno: 196 }, { filename: "[native code]" }] },
    };

    expect(beforeSend(exception(translator))).toBeNull();
  });

  test("keeps an error thrown through a native call in our code", () => {
    const ours = {
      type: "URIError",
      value: "URI malformed",
      stacktrace: { frames: [{ filename: "<anonymous>" }, { filename: "https://donkeycut.com/_next/static/chunks/a.js?dpl=1" }] },
    };

    expect(beforeSend(exception(ours))).not.toBeNull();
  });

  test("drops a bare dropped fetch", () => {
    // The router logs its own failed RSC fetch, then navigates the browser.
    const dropped = { type: "TypeError", value: "Failed to fetch" };

    expect(beforeSend(exception(dropped))).toBeNull();
  });

  test("keeps a worded report whose cause is a dropped fetch", () => {
    const report = { type: "Error", value: "[cut] export upload failed" };
    const cause = { type: "TypeError", value: "Failed to fetch" };

    expect(beforeSend(exception(report, cause))).not.toBeNull();
  });

  test("keeps an error our own code threw", () => {
    const ours = {
      type: "TypeError",
      value: "Cannot read properties of undefined (reading 'clips')",
      stacktrace: { frames: [{ filename: "https://donkeycut.com/_next/static/chunks/a.js" }] },
    };

    expect(beforeSend(exception(ours))).not.toBeNull();
  });
});
