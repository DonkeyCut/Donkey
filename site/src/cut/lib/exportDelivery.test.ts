import { expect, test } from "bun:test";
import { specMediaFiles } from "./exportDelivery";

// What a render has to fetch from the project's own media folder. A block's
// card is painted by the client and travels with the job, so listing it here
// sends the worker looking for an object that was never stored and stages it
// where the render does not read.
test("a staged picture is not one of the project's media files", () => {
  const files = specMediaFiles({
    clips: [
      { file: "a.mp4" },
      { file: "block_1.png", staged: true },
      { file: "b.mp4" },
    ],
    overlayVideos: [{ file: "pip.mp4" }],
    audio: [{ file: "music.mp3" }],
  });
  expect(files).toEqual(["a.mp4", "b.mp4", "pip.mp4", "music.mp3"]);
});

test("each media file is listed once", () => {
  expect(specMediaFiles({ clips: [{ file: "a.mp4" }, { file: "a.mp4" }] })).toEqual(["a.mp4"]);
});
