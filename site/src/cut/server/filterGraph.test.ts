import { describe, expect, test } from "bun:test";
import { assertGraphSafe, fexpr } from "./filterGraph";

const thrown = (fn: () => unknown): string => {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("filter graph safety", () => {
  test("fexpr quotes an expression so its commas ride through the graph parser", () => {
    expect(fexpr("min(iw,330)")).toBe("'min(iw,330)'");
  });

  test("fexpr refuses an expression carrying a single quote", () => {
    expect(thrown(() => fexpr("min(iw,'330')"))).toContain("single quote");
  });

  test("a bare comma inside a call is caught before ffmpeg sees it", () => {
    expect(
      thrown(() =>
        assertGraphSafe("[1:v]scale=330:716,crop=min(iw,330):min(ih,716):(iw-ow)*0.5[o]")
      )
    ).toContain("fexpr()");
  });

  test("quoted and escaped commas pass, as do the chain and graph separators", () => {
    const g =
      "[0:v]crop='min(iw,330)':'min(ih,716)',fps=30[v0];" +
      "[1:v]crop=min(iw\\,64):min(ih\\,64),overlay=enable='between(t,1,2)'[v1]";
    expect(assertGraphSafe(g)).toBe(g);
  });
});
