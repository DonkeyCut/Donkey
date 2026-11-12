import { beforeEach, describe, expect, test } from "bun:test";
import { hasHomeHandoff, saveHomeHandoff, takeHomeHandoff, type HomeHandoff } from "./homeHandoff";
import type { AssetRef } from "./assetRef";

// A Map-backed stand-in for the tab's session storage.
class MemoryStorage {
  private items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
}

const clip: AssetRef = { scope: "library", id: "a1", name: "beach", kind: "video", url: "https://x/beach.mp4" };
const font: AssetRef = {
  scope: "library",
  id: "f1",
  name: "Inter",
  kind: "text",
  url: "data:text/plain,font",
  use: { noun: "font", tool: "set_font", args: { id: "f1" } },
};
const handoff: HomeHandoff = { text: "make a recap", attachments: [clip, font], model: "chat" };

beforeEach(() => {
  (globalThis as { sessionStorage?: unknown }).sessionStorage = new MemoryStorage();
});

describe("home handoff", () => {
  test("the editor takes the message once", () => {
    saveHomeHandoff("p1", handoff);

    expect(hasHomeHandoff("p1")).toBe(true);
    expect(takeHomeHandoff("p1")).toEqual(handoff);
    expect(hasHomeHandoff("p1")).toBe(false);
    expect(takeHomeHandoff("p1")).toBeNull();
  });

  test("a message waits only for its own project", () => {
    saveHomeHandoff("p1", handoff);

    expect(takeHomeHandoff("p2")).toBeNull();
    expect(takeHomeHandoff("p1")?.text).toBe("make a recap");
  });

  test("refs keep every field they were saved with", () => {
    saveHomeHandoff("p1", handoff);

    expect(takeHomeHandoff("p1")?.attachments[1].use).toEqual(font.use);
  });

  test("a malformed or empty entry reads as none and is cleared", () => {
    sessionStorage.setItem("cut-home-handoff:p1", "{not json");
    saveHomeHandoff("p2", { text: "  ", attachments: [], model: "chat" });

    expect(takeHomeHandoff("p1")).toBeNull();
    expect(hasHomeHandoff("p1")).toBe(false);
    expect(takeHomeHandoff("p2")).toBeNull();
  });

  test("blocked storage reads as no message", () => {
    (globalThis as { sessionStorage?: unknown }).sessionStorage = undefined;

    saveHomeHandoff("p1", handoff);
    expect(takeHomeHandoff("p1")).toBeNull();
  });
});
