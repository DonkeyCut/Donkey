import { describe, expect, test } from "bun:test";
import type { AssetRef } from "./assetRef";
import { startAspect } from "./startAspect";

/** A picked file with the pixel size its catalog knows. */
function ref(kind: AssetRef["kind"], width?: number, height?: number): AssetRef {
  return { scope: "library", id: `${kind}-${width}x${height}`, name: "clip", kind, url: "/x", width, height };
}

describe("startAspect", () => {
  test("one picture sets the frame to its own shape", () => {
    expect(startAspect([ref("video", 1080, 1920)])).toBe("9:16");
    expect(startAspect([ref("image", 2560, 1080)])).toBe("64:27");
  });

  test("several sizes take the biggest picture", () => {
    expect(startAspect([ref("video", 1080, 1920), ref("video", 3840, 2160), ref("image", 1000, 1000)])).toBe("16:9");
  });

  test("a size that does not reduce lands on its two-place ratio", () => {
    expect(startAspect([ref("video", 1997, 1123)])).toBe("89:50");
    expect(startAspect([ref("video", 1123, 1997)])).toBe("50:89");
  });

  test("audio, text and unsized refs leave the frame alone", () => {
    expect(startAspect([ref("audio"), ref("text"), ref("video")])).toBeNull();
    expect(startAspect([])).toBeNull();
  });
});
