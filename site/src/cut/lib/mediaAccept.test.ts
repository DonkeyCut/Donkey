import { describe, expect, test } from "bun:test";
import { isMediaFile, MEDIA_ACCEPT } from "./media";

/** The OS picker lists what a drop takes: every extension the classifiers
 * accept for a file with no MIME type appears in the input's `accept`. */
describe("MEDIA_ACCEPT", () => {
  const accepted = new Set(MEDIA_ACCEPT.split(","));

  test("lists every media family by MIME", () => {
    for (const family of ["video/*", "audio/*", "image/*"]) expect(accepted.has(family)).toBe(true);
  });

  test("every listed extension is one a drop accepts, images included", () => {
    const extensions = [...accepted].filter((entry) => entry.startsWith("."));
    expect(extensions).toContain(".png");
    expect(extensions).toContain(".jpeg");
    expect(extensions).toContain(".jpg");
    for (const ext of extensions) {
      expect(isMediaFile(new File([], `clip${ext}`, { type: "" }))).toBe(true);
    }
  });
});
