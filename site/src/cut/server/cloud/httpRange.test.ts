import { describe, expect, test } from "bun:test";
import { parseRange } from "./httpRange";

const SIZE = 1000;

describe("parseRange", () => {
  test("no header means the whole object", () => {
    expect(parseRange(null, SIZE)).toBe(null);
    expect(parseRange(undefined, SIZE)).toBe(null);
    expect(parseRange("", SIZE)).toBe(null);
  });

  test("a closed range is inclusive at both ends", () => {
    expect(parseRange("bytes=0-99", SIZE)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-199", SIZE)).toEqual({ start: 100, end: 199 });
  });

  test("an open range runs to the last byte", () => {
    expect(parseRange("bytes=0-", SIZE)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=500-", SIZE)).toEqual({ start: 500, end: 999 });
  });

  test("a suffix range counts back from the end", () => {
    expect(parseRange("bytes=-500", SIZE)).toEqual({ start: 500, end: 999 });
    // Asking for more than exists yields the whole object, not a negative start.
    expect(parseRange("bytes=-5000", SIZE)).toEqual({ start: 0, end: 999 });
  });

  test("an end past the object clamps instead of overrunning", () => {
    expect(parseRange("bytes=900-5000", SIZE)).toEqual({ start: 900, end: 999 });
  });

  test("the last single byte is reachable", () => {
    expect(parseRange("bytes=999-999", SIZE)).toEqual({ start: 999, end: 999 });
    expect(parseRange("bytes=-1", SIZE)).toEqual({ start: 999, end: 999 });
  });

  test("unsatisfiable ranges are refused rather than coerced", () => {
    expect(parseRange("bytes=1000-", SIZE)).toBe("invalid"); // starts past the end
    expect(parseRange("bytes=200-100", SIZE)).toBe("invalid"); // backwards
    expect(parseRange("bytes=-0", SIZE)).toBe("invalid"); // empty suffix
    expect(parseRange("bytes=-", SIZE)).toBe("invalid");
    expect(parseRange("bytes=0-99", 0)).toBe("invalid"); // empty object
  });

  test("shapes we do not serve are refused, not guessed at", () => {
    expect(parseRange("bytes=0-99, 200-299", SIZE)).toBe("invalid"); // multi-range
    expect(parseRange("items=0-99", SIZE)).toBe("invalid"); // wrong unit
    expect(parseRange("bytes=abc-def", SIZE)).toBe("invalid");
  });

  test("surrounding whitespace is tolerated", () => {
    expect(parseRange("  bytes=0-99  ", SIZE)).toEqual({ start: 0, end: 99 });
  });
});
