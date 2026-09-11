import { describe, expect, test } from "bun:test";

import { linkFromText } from "./link";

describe("linkFromText", () => {
  test("one address pastes as a link, with or without its scheme", () => {
    expect(linkFromText("https://youtube.com/watch?v=abc")).toBe("https://youtube.com/watch?v=abc");
    expect(linkFromText("  youtube.com/watch?v=abc\n")).toBe("https://youtube.com/watch?v=abc");
  });

  test("anything that is not one address is left alone", () => {
    expect(linkFromText("")).toBeNull();
    expect(linkFromText("beach sunset")).toBeNull();
    expect(linkFromText("@v2")).toBeNull();
    expect(linkFromText("https://a.com\nhttps://b.com")).toBeNull();
    expect(linkFromText("mailto:someone@example.com")).toBeNull();
  });
});
