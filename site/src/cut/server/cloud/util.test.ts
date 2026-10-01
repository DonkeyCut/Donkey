import { expect, test } from "bun:test";
import { safeFileName, storableFileName } from "./util";

test("a block asset's empty name and dotfiles have no storable name", () => {
  expect(storableFileName("")).toBeNull();
  expect(storableFileName(".DS_Store")).toBeNull();
  expect(() => safeFileName("")).toThrow("Invalid file name.");
});

test("a storable name is sanitized to its basename", () => {
  expect(storableFileName("clips/phone 1.mov")).toBe("phone 1.mov");
  expect(storableFileName("a:b.mp4")).toBe("a_b.mp4");
  expect(safeFileName("clips/phone 1.mov")).toBe("phone 1.mov");
});
