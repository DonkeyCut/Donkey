import { describe, expect, test } from "bun:test";
import { additiveClickOn, newTabClickOn, snapHeldOffOn } from "./hostKeys";

const mods = (m: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }>) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...m,
});

describe("platform modifiers", () => {
  test("a Mac adds with cmd and leaves ctrl to the context menu", () => {
    expect(additiveClickOn(true, mods({ metaKey: true }))).toBe(true);
    expect(additiveClickOn(true, mods({ ctrlKey: true }))).toBe(false);
    expect(snapHeldOffOn(true, mods({ ctrlKey: true }))).toBe(false);
  });

  test("Windows and Linux add with ctrl", () => {
    expect(additiveClickOn(false, mods({ ctrlKey: true }))).toBe(true);
    expect(additiveClickOn(false, mods({ metaKey: true }))).toBe(false);
    expect(snapHeldOffOn(false, mods({ ctrlKey: true }))).toBe(true);
  });

  test("shift adds on either", () => {
    expect(additiveClickOn(true, mods({ shiftKey: true }))).toBe(true);
    expect(additiveClickOn(false, mods({ shiftKey: true }))).toBe(true);
  });

  test("a new tab opens on cmd on a Mac and ctrl elsewhere", () => {
    expect(newTabClickOn(true, mods({ metaKey: true }))).toBe(true);
    expect(newTabClickOn(true, mods({ ctrlKey: true }))).toBe(false);
    expect(newTabClickOn(false, mods({ ctrlKey: true }))).toBe(true);
    expect(newTabClickOn(false, mods({ metaKey: true }))).toBe(false);
    expect(newTabClickOn(true, mods({ shiftKey: true }))).toBe(false);
  });
});
