import { describe, expect, test } from "bun:test";
import { additiveClickOn, snapHeldOffOn } from "./hostKeys";

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
});
