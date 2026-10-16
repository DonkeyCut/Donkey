import { describe, expect, test } from "bun:test";

import { reloadOnChunkError } from "./chunkReload";

type Listener = (e: unknown) => void;

// A window with just what the recovery touches: listeners, reload, a clock and
// session storage.
const fakeWindow = (now = 1_000_000) => {
  const listeners = new Map<string, Listener>();
  const store = new Map<string, string>();
  const win = {
    reloads: 0,
    now,
    addEventListener(type: string, fn: (e: never) => void) {
      listeners.set(type, fn as Listener);
    },
    location: { reload: () => (win.reloads += 1) },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
    fire: (type: string, e: unknown) => listeners.get(type)?.(e),
  };
  return win;
};

const chunkError = () => Object.assign(new Error("Failed to load chunk /_next/static/chunks/a.js"), { name: "ChunkLoadError" });

describe("reloadOnChunkError", () => {
  test("reloads when a lazy chunk fails to load", () => {
    const win = fakeWindow();
    reloadOnChunkError(win, () => win.now);

    win.fire("unhandledrejection", { reason: chunkError() });

    expect(win.reloads).toBe(1);
  });

  test("reloads on an uncaught chunk error too", () => {
    const win = fakeWindow();
    reloadOnChunkError(win, () => win.now);

    win.fire("error", { error: chunkError() });

    expect(win.reloads).toBe(1);
  });

  test("does not loop when the chunk fails again right after the reload", () => {
    const win = fakeWindow();
    reloadOnChunkError(win, () => win.now);
    win.fire("error", { error: chunkError() });

    win.now += 2_000;
    win.fire("error", { error: chunkError() });

    expect(win.reloads).toBe(1);
  });

  test("leaves every other error alone", () => {
    const win = fakeWindow();
    reloadOnChunkError(win, () => win.now);

    win.fire("error", { error: new TypeError("x is undefined") });

    expect(win.reloads).toBe(0);
  });
});
