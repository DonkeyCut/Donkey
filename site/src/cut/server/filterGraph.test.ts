import { describe, expect, test } from "bun:test";
import { assertGraphSafe, fanOutInputs, fexpr } from "./filterGraph";

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

describe("input fan-out", () => {
  test("a stream read more than once is split once, each read taking its own branch", () => {
    const g = fanOutInputs([
      "[0:v]trim=0:2,setpts=PTS-STARTPTS[v0]",
      "[0:a]atrim=0:2,asetpts=PTS-STARTPTS[a0]",
      "[0:v]trim=5:7,setpts=PTS-STARTPTS[v1]",
      "[0:a]atrim=5:7,asetpts=PTS-STARTPTS[a1]",
    ]);
    expect(g).toEqual([
      "[0:v]split=2[fan0_v_0][fan0_v_1]",
      "[0:a]asplit=2[fan0_a_0][fan0_a_1]",
      "[fan0_v_0]trim=0:2,setpts=PTS-STARTPTS[v0]",
      "[fan0_a_0]atrim=0:2,asetpts=PTS-STARTPTS[a0]",
      "[fan0_v_1]trim=5:7,setpts=PTS-STARTPTS[v1]",
      "[fan0_a_1]atrim=5:7,asetpts=PTS-STARTPTS[a1]",
    ]);
  });

  test("a stream named with and without its index is one stream", () => {
    expect(fanOutInputs(["[3:a]atrim=0:2[a0]", "[3:a:0]atrim=4:6[a1]"])).toEqual([
      "[3:a]asplit=2[fan3_a_0][fan3_a_1]",
      "[fan3_a_0]atrim=0:2[a0]",
      "[fan3_a_1]atrim=4:6[a1]",
    ]);
  });

  test("a pad spelled inside a quoted option value is text, never a read", () => {
    const g = ["[0:v]trim=0:2[v0]", "[v0]lut3d=file='/tmp/[0:v].cube'[v1]"];
    expect(fanOutInputs(g)).toEqual(g);
  });

  test("a stream read once, and a graph's own labels, are left as written", () => {
    const g = ["[0:v]trim=0:2[v0]", "[1:a:0]atrim=0:2[a0]", "[v0][2:v]overlay[o]"];
    expect(fanOutInputs(g)).toEqual(g);
  });
});
