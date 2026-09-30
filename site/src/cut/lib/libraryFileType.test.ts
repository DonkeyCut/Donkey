import { describe, expect, test } from "bun:test";
import { libraryTypeOf } from "./libraryFileType";

describe("libraryTypeOf", () => {
  test("reads the kind off the extension, whatever its case", () => {
    expect(libraryTypeOf("clip.MOV")).toBe("video");
    expect(libraryTypeOf("song.m4a")).toBe("audio");
    expect(libraryTypeOf("still.jpeg")).toBe("image");
    expect(libraryTypeOf("Inter.woff2")).toBe("font");
    expect(libraryTypeOf("Kodak 2383.cube")).toBe("lut");
    expect(libraryTypeOf("look.3DL")).toBe("lut");
  });

  test("refuses what no shelf takes", () => {
    expect(libraryTypeOf("notes.txt")).toBeNull();
    expect(libraryTypeOf("archive.zip")).toBeNull();
    expect(libraryTypeOf("cube")).toBeNull();
  });
});
