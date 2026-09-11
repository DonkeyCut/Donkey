import { describe, expect, test } from "bun:test";

import { blogSlugSchema, publishIssues, slugFromTitle } from "./schema";

describe("blogSlugSchema", () => {
  test("accepts lowercase hyphenated words", () => {
    expect(blogSlugSchema.safeParse("smooth-slow-motion-2026").success).toBe(true);
  });

  test("refuses dots, capitals, doubled hyphens and reserved words", () => {
    for (const slug of ["next.js-tips", "Hello", "a--b", "-lead", "page", ""]) {
      expect(blogSlugSchema.safeParse(slug).success).toBe(false);
    }
  });
});

describe("slugFromTitle", () => {
  test("hyphenates the words of a title", () => {
    expect(slugFromTitle("Smooth Slow-Mo & RIFE: what changed?")).toBe("smooth-slow-mo-and-rife-what-changed");
  });
});

describe("publishIssues", () => {
  const ready = {
    title: "A title",
    excerpt: "x".repeat(120),
    summary: null,
    headerKey: "blog/a/b.avif",
    thumbnailKey: "blog/a/c.avif",
    publishedAt: null,
    body: "Hello",
  };

  test("a complete post has no issues", () => {
    expect(publishIssues(ready)).toEqual([]);
  });

  test("each missing piece is named", () => {
    const paths = publishIssues({
      ...ready,
      title: "",
      excerpt: "short",
      headerKey: null,
      thumbnailKey: null,
      publishedAt: new Date(Date.now() + 86_400_000).toISOString(),
      body: " ",
    }).map((issue) => issue.path);
    expect(paths).toEqual(["title", "excerpt", "header", "thumbnail", "publishedAt", "body"]);
  });
});
