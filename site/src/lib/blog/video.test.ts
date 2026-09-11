import { describe, expect, test } from "bun:test";

import { parseVideoUrl } from "./video";

describe("parseVideoUrl", () => {
  test("youtube watch, short and shorts links embed by id", () => {
    expect(parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      kind: "youtube",
      embedSrc: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    });
    expect(parseVideoUrl("https://youtu.be/dQw4w9WgXcQ?t=1m30s")).toEqual({
      kind: "youtube",
      embedSrc: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90",
    });
    expect(parseVideoUrl("https://youtube.com/shorts/dQw4w9WgXcQ")?.kind).toBe("youtube");
  });

  test("vimeo links embed through the player, keeping an unlisted hash", () => {
    expect(parseVideoUrl("https://vimeo.com/123456789")).toEqual({
      kind: "vimeo",
      embedSrc: "https://player.vimeo.com/video/123456789",
    });
    expect(parseVideoUrl("https://vimeo.com/123456789/abcdef0123")).toEqual({
      kind: "vimeo",
      embedSrc: "https://player.vimeo.com/video/123456789?h=abcdef0123",
    });
  });

  test("direct files play as files", () => {
    expect(parseVideoUrl("https://media.donkeycut.com/x/y/clip.mp4")).toEqual({
      kind: "file",
      src: "https://media.donkeycut.com/x/y/clip.mp4",
    });
    expect(parseVideoUrl("https://example.com/a.webm?x=1")?.kind).toBe("file");
  });

  test("anything else is not a video", () => {
    expect(parseVideoUrl("https://example.com/watch")).toBeNull();
    expect(parseVideoUrl("not a url")).toBeNull();
    expect(parseVideoUrl("ftp://youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
});
