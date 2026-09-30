import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { movieHeader } from "../lib/fixtures/movieHeader";
import type { Overlay, VideoClip } from "../lib/types";
import { probeFileColor, withFileColors, withSpecColors } from "./fileColor";

const dir = await mkdtemp(path.join(tmpdir(), "file-color-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
await writeFile(path.join(dir, "hlg.mp4"), movieHeader({ primaries: 9, transfer: 18, matrix: 9 }));
await writeFile(path.join(dir, "social.mp4"), movieHeader({ primaries: 9, transfer: 18, matrix: 1 }));
const at = (file: string) => path.join(dir, file);

test("a file's color is read off the disk", async () => {
  expect((await probeFileColor(at("hlg.mp4"))).detected).toBe("hlg");
  // A bt709-matrix transcode keeps its HLG tags and is SDR.
  expect((await probeFileColor(at("social.mp4"))).detected).toBe("rec709");
});

test("a spec that arrives without a clip's color reads it from the file", async () => {
  const spec = {
    clips: [
      { file: "hlg.mp4" },
      { file: "social.mp4", color: { profile: "apple-log" as const, matrix: "bt2020nc" as const, fullRange: false } },
      { file: "still.png", image: true },
      { file: "gone.mp4" },
    ],
    overlayVideos: [{ file: "hlg.mp4" }],
  };
  const filled = await withSpecColors(spec, at);
  expect(filled.clips[0].color).toEqual({ profile: "hlg", matrix: "bt2020nc", fullRange: false });
  // What the spec said stands.
  expect(filled.clips[1].color).toEqual(spec.clips[1].color);
  expect(filled.clips[2]).toEqual(spec.clips[2]);
  // A file that is not there is the render's to name.
  expect(filled.clips[3]).toEqual({ file: "gone.mp4" });
  expect((filled.overlayVideos![0] as { color?: unknown }).color).toEqual({ profile: "hlg", matrix: "bt2020nc", fullRange: false });
});

const clipOf = (assetId: string) => ({ assetId }) as VideoClip;

test("assets the timeline draws without a color record get one, once per file", async () => {
  const assets = [
    { id: "1", type: "video", fileName: "hlg.mp4" },
    { id: "2", type: "video", fileName: "hlg.mp4" },
    { id: "3", type: "video", fileName: "social.mp4", color: { detected: "pq" } },
    { id: "4", type: "audio", fileName: "song.mp3" },
  ];
  const filled = await withFileColors(assets, { clips: ["1", "2", "3", "4"].map(clipOf), overlays: [] }, at);
  expect(filled[0].color).toMatchObject({ detected: "hlg", matrix: "bt2020nc", codec: "avc1" });
  expect(filled[1].color).toEqual(filled[0].color);
  expect(filled[2].color).toEqual({ detected: "pq" });
  expect(filled[3]).toEqual(assets[3]);
});

test("an unreadable file nothing draws is skipped; one the timeline draws fails the call", async () => {
  const assets: { id: string; type: string; fileName: string; color?: unknown }[] = [
    { id: "1", type: "video", fileName: "hlg.mp4" },
    { id: "2", type: "video", fileName: "gone.mp4" },
  ];
  // An unused Media-panel file never blocks the project it sits in.
  const filled = await withFileColors(assets, { clips: [clipOf("1")], overlays: [] }, at);
  expect(filled[0].color).toMatchObject({ detected: "hlg" });
  expect(filled[1]).toEqual(assets[1]);
  // An upper-track clip or an element that draws it makes it the render's.
  await expect(withFileColors(assets, { clips: [clipOf("1"), clipOf("2")], overlays: [] }, at)).rejects.toThrow(
    "The color of gone.mp4 could not be read"
  );
  await expect(
    withFileColors(assets, { clips: [], overlays: [{ kind: "sticker", assetId: "2" } as Overlay] }, at)
  ).rejects.toThrow("gone.mp4");
});
