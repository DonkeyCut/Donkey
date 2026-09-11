import { describe, expect, test } from "bun:test";

import { blogImageKey, blogPageHref, blogUploadKey, isBlogImageKey } from "./keys";

describe("blog keys", () => {
  const sha = "a".repeat(64);

  test("only a content-addressed avif under the post is a public image key", () => {
    expect(isBlogImageKey("post1", blogImageKey("post1", sha))).toBe(true);
    expect(isBlogImageKey("post2", blogImageKey("post1", sha))).toBe(false);
    expect(isBlogImageKey("post1", blogUploadKey("post1", "u1"))).toBe(false);
    expect(isBlogImageKey("post1", "blog/post1/article.mdx")).toBe(false);
  });

  test("page one is the bare index", () => {
    expect(blogPageHref(1)).toBe("/blog");
    expect(blogPageHref(3)).toBe("/blog/page/3");
  });
});
