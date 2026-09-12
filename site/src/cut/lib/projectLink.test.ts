import { describe, expect, test } from "bun:test";

import { parseProjectLink } from "./projectLink";

describe("parseProjectLink", () => {
  test("a project page link names the project", () => {
    expect(parseProjectLink("https://donkeycut.com/app/p/abc-123")).toEqual({ kind: "project", id: "abc-123" });
    expect(parseProjectLink("donkeycut.com/app/p/abc-123?from=home")).toEqual({ kind: "project", id: "abc-123" });
    expect(parseProjectLink("http://127.0.0.1:41417/cut/app/p/starter-u1#x")).toEqual({ kind: "project", id: "starter-u1" });
    expect(parseProjectLink(" https://donkeycut.com/app/p/abc/ ")).toEqual({ kind: "project", id: "abc" });
  });

  test("a share link names the token", () => {
    expect(parseProjectLink("https://donkeycut.com/s/tok_ABC-9")).toEqual({ kind: "share", token: "tok_ABC-9" });
    expect(parseProjectLink("donkeycut.com/cut/s/tok")).toEqual({ kind: "share", token: "tok" });
  });

  test("a bare id is a project", () => {
    expect(parseProjectLink("cmf1abc2")).toEqual({ kind: "project", id: "cmf1abc2" });
  });

  test("anything else is refused", () => {
    expect(parseProjectLink("")).toBeNull();
    expect(parseProjectLink("https://youtube.com/watch?v=abc")).toBeNull();
    expect(parseProjectLink("https://donkeycut.com/app")).toBeNull();
    expect(parseProjectLink("https://donkeycut.com/app/p/a b")).toBeNull();
    expect(parseProjectLink("https://a.com/app/p/x https://b.com/app/p/y")).toBeNull();
    expect(parseProjectLink("mailto:someone@example.com")).toBeNull();
  });
});
