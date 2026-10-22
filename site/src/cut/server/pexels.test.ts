import { describe, expect, test } from "bun:test";
import { pexelsFileUrl, pexelsVideo } from "./pexels";

describe("pexelsVideo", () => {
  test("reads the id and the words of a video page link", () => {
    expect(pexelsVideo("https://www.pexels.com/video/a-man-snowboarding-6947537/")).toEqual({
      id: "6947537",
      title: "A man snowboarding",
    });
    expect(pexelsVideo("https://pexels.com/es-es/video/ski-resort-853808")).toEqual({ id: "853808", title: "Ski resort" });
  });

  test("reads a file link on the CDN, which is its own file", () => {
    expect(pexelsVideo("https://videos.pexels.com/video-files/31934986/13602850_1920_1080_30fps.mp4")).toEqual({
      id: "31934986",
      title: "Pexels 31934986",
      file: "https://videos.pexels.com/video-files/31934986/13602850_1920_1080_30fps.mp4",
    });
  });

  test("leaves every other link alone", () => {
    expect(pexelsVideo("https://www.pexels.com/search/videos/snow/")).toBeNull();
    expect(pexelsVideo("https://www.tiktok.com/@a/video/7626749283018263815")).toBeNull();
    expect(pexelsVideo("https://www.pexels.com/photo/snow-123/")).toBeNull();
  });
});

describe("pexelsFileUrl", () => {
  // The CDN's files for one video, as a HEAD answers them.
  const cdn = (files: string[]) => async (url: string) => files.some((f) => url.endsWith(`/${f}`));

  test("takes the 1080p file at whatever rate it was shot", async () => {
    const has = cdn(["6286880-uhd_3840_2160_30fps.mp4", "6286880-hd_1920_1080_30fps.mp4", "6286880-hd_1280_720_60fps.mp4"]);
    expect(await pexelsFileUrl("6286880", has)).toBe(
      "https://videos.pexels.com/video-files/6286880/6286880-hd_1920_1080_30fps.mp4"
    );
  });

  test("a portrait video's 1080p is 1080 wide", async () => {
    expect(await pexelsFileUrl("9", cdn(["9-hd_1080_1920_25fps.mp4", "9-sd_540_960_25fps.mp4"]))).toBe(
      "https://videos.pexels.com/video-files/9/9-hd_1080_1920_25fps.mp4"
    );
  });

  test("an old video with no 1080p falls back to the largest it has", async () => {
    expect(await pexelsFileUrl("1581362", cdn(["1581362-sd_960_540_30fps.mp4", "1581362-sd_640_360_30fps.mp4"]))).toBe(
      "https://videos.pexels.com/video-files/1581362/1581362-sd_960_540_30fps.mp4"
    );
  });

  test("nothing on the CDN is null", async () => {
    expect(await pexelsFileUrl("1", cdn([]))).toBeNull();
  });
});
