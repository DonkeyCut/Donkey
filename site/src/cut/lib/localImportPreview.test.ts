import { describe, expect, test } from "bun:test";
import { useLightbox } from "@/cut/lib/lightbox";
import { openLocalImport } from "@/cut/lib/localImportPreview";

describe("openLocalImport", () => {
  // The viewer opens at the arriving clip's shape, wearing its frame and length.
  test("carries the tile's shape, length and frame", () => {
    const file = new File([new Uint8Array(8)], "IMG_5388.MOV", { type: "video/quicktime" });
    const poster = new Blob([new Uint8Array(4)], { type: "image/jpeg" });
    openLocalImport(file, "video", { width: 1080, height: 1920, duration: 21.8, poster });
    const item = useLightbox.getState().item;
    expect(item?.ratio).toBe(1080 / 1920);
    expect(item?.duration).toBe(21.8);
    expect(item?.poster?.startsWith("blob:")).toBe(true);
    useLightbox.getState().close();
  });

  // Nothing measured yet leaves the viewer to learn the shape from the file.
  test("opens without a shape when the tile has none", () => {
    const file = new File([new Uint8Array(8)], "a.png", { type: "image/png" });
    openLocalImport(file, "image");
    const item = useLightbox.getState().item;
    expect(item?.ratio).toBeUndefined();
    expect(item?.poster).toBeUndefined();
    useLightbox.getState().close();
  });
});
