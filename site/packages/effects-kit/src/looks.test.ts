import { describe, expect, test } from "bun:test";
import { lookCssFilter, lookFilterLines, lookPost } from "./looks";
import { LOOK_IDS } from "./index";

describe("lookFilterLines", () => {
  test("every look renders lines from [in] to [out] ending in the format", () => {
    for (const id of LOOK_IDS) {
      const lines = lookFilterLines("in0", "out0", id, 1, 1920, "yuv420p", "t0");
      expect(lines === null).toBe(false);
      expect(lines![0].startsWith("[in0]")).toBe(true);
      const last = lines![lines!.length - 1];
      expect(last.endsWith("[out0]")).toBe(true);
      expect(last.includes("format=yuv420p")).toBe(true);
    }
  });

  test("halation and dreamy are split/blend graphs", () => {
    expect(lookFilterLines("a", "b", "halation", 1, 1920, "yuv420p", "t")!.length).toBe(3);
    expect(lookFilterLines("a", "b", "dreamy", 1, 1920, "yuv420p", "t")!.length).toBe(3);
  });

  test("halation's luma knee scales to the plane's depth", () => {
    expect(lookFilterLines("a", "b", "halation", 1, 1920, "yuv420p", "t")!.join(";")).toContain(
      "lutyuv=y='clip((val-160)*3,0,255)'"
    );
    expect(lookFilterLines("a", "b", "halation", 1, 1920, "yuv420p10le", "t", 10)!.join(";")).toContain(
      "lutyuv=y='clip((val-641.882)*3,0,1023)'"
    );
    // Every other look is written in ratios and carries no code value.
    for (const style of ["vintage", "vhs", "horror", "tech", "noir", "grain", "pastel", "blockbuster", "dreamy"]) {
      const at8 = lookFilterLines("a", "b", style, 1, 1920, "yuv420p", "t")!.join(";");
      const at10 = lookFilterLines("a", "b", style, 1, 1920, "yuv420p10le", "t", 10)!.join(";");
      expect(at10).toBe(at8.replaceAll("format=yuv420p", "format=yuv420p10le"));
    }
  });

  test("an unknown id returns null instead of failing the job", () => {
    expect(lookFilterLines("a", "b", "sparkle", 1, 1920, "yuv420p", "t")).toBe(null);
    expect(lookFilterLines("a", "b", "", 1, 1920, "yuv420p", "t")).toBe(null);
  });

  test("amount is clamped into (0.05..1]", () => {
    const over = lookFilterLines("a", "b", "noir", 5, 1920, "yuv420p", "t")!;
    const full = lookFilterLines("a", "b", "noir", 1, 1920, "yuv420p", "t")!;
    expect(over).toEqual(full);
    const zero = lookFilterLines("a", "b", "noir", 0, 1920, "yuv420p", "t")!;
    const floor = lookFilterLines("a", "b", "noir", 0.05, 1920, "yuv420p", "t")!;
    expect(zero).toEqual(floor);
  });

  test("blur radii scale with the output height", () => {
    const at1080 = lookFilterLines("a", "b", "halation", 1, 1920, "yuv420p", "t")!.join(";");
    const at720 = lookFilterLines("a", "b", "halation", 1, 1280, "yuv420p", "t")!.join(";");
    expect(at1080.includes("gblur=sigma=18")).toBe(true);
    expect(at720.includes("gblur=sigma=12")).toBe(true);
  });
});

describe("canvas recipes", () => {
  test("every look has a css filter or a post pass", () => {
    for (const id of LOOK_IDS) {
      expect(lookCssFilter(id, 1) !== "" || lookPost(id, 1) !== null).toBe(true);
    }
  });

  test("no look leaks NaN into its css filter", () => {
    for (const id of LOOK_IDS) {
      expect(lookCssFilter(id, 0.3).includes("NaN")).toBe(false);
    }
  });
});
