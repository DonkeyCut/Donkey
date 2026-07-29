import { describe, expect, test } from "bun:test";
import { foldClips } from "./audioMix";
import { bitrateFor, mixSpecFor } from "./exportRender";
import type { ExportDoc } from "./exportClient";
import type { MediaAsset, VideoClip } from "./types";

const asset = (id: string): MediaAsset => ({
  id,
  fileName: `${id}.mp4`,
  name: id,
  type: "video",
  duration: 60,
  url: `https://media.test/${id}.mp4`,
});

const clip = (over: Partial<VideoClip> & { id: string; assetId: string }): VideoClip => ({
  track: 0,
  start: 0,
  in: 0,
  out: 4,
  muted: false,
  ...over,
});

const doc = (over: Partial<ExportDoc> = {}): ExportDoc => ({
  aspect: "16:9",
  assets: [asset("a"), asset("b")],
  clips: [],
  audioClips: [],
  overlays: [],
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
  ...over,
});

const resolve = (a: MediaAsset) => a.url;

describe("mixSpecFor", () => {
  test("keeps the audio under the picture when track 0 has a leading gap", () => {
    const spec = mixSpecFor(
      doc({ clips: [clip({ id: "c1", assetId: "a", start: 3 })] }),
      resolve
    );
    const geo = foldClips(spec.clips);
    // The clip sits at 3s on the timeline, so its audio has to start at 3s.
    const voiced = geo.find((g) => g.clip.file !== "");
    expect(voiced?.at).toBeCloseTo(3, 5);
  });

  test("keeps the audio under the picture across a mid-timeline gap", () => {
    const spec = mixSpecFor(
      doc({
        clips: [
          clip({ id: "c1", assetId: "a", start: 0, out: 2 }),
          clip({ id: "c2", assetId: "b", start: 5, out: 2 }),
        ],
      }),
      resolve
    );
    const geo = foldClips(spec.clips);
    const voiced = geo.filter((g) => g.clip.file !== "");
    expect(voiced[0].at).toBeCloseTo(0, 5);
    expect(voiced[1].at).toBeCloseTo(5, 5);
  });

  test("lays abutting clips out with no spacer between them", () => {
    const spec = mixSpecFor(
      doc({
        clips: [
          clip({ id: "c1", assetId: "a", start: 0, out: 2 }),
          clip({ id: "c2", assetId: "b", start: 2, out: 2 }),
        ],
      }),
      resolve
    );
    expect(spec.clips.every((c) => c.file !== "")).toBe(true);
  });

  test("mutes a still, which has no sound to read", () => {
    const still: MediaAsset = { ...asset("s"), type: "image", fileName: "s.png" };
    const spec = mixSpecFor(
      doc({ assets: [still], clips: [clip({ id: "c1", assetId: "s" })] }),
      resolve
    );
    expect(spec.clips[0].muted).toBe(true);
  });

  test("carries an overlay clip's fade so its sound ramps with its picture", () => {
    const spec = mixSpecFor(
      doc({
        clips: [
          clip({ id: "c0", assetId: "a" }),
          clip({
            id: "c1",
            assetId: "b",
            track: 1,
            start: 1,
            animIn: { style: "fade", seconds: 0.5 },
            animOut: { style: "fade", seconds: 0.75 },
          }),
        ],
      }),
      resolve
    );
    const overlay = spec.items.find((i) => i.start === 1);
    expect(overlay?.fadeIn).toBeCloseTo(0.5, 5);
    expect(overlay?.fadeOut).toBeCloseTo(0.75, 5);
  });

  test("gives a zoom no audio ramp, since it does not change loudness", () => {
    const spec = mixSpecFor(
      doc({
        clips: [
          clip({ id: "c0", assetId: "a" }),
          clip({
            id: "c1",
            assetId: "b",
            track: 1,
            start: 1,
            animIn: { style: "zoom", seconds: 0.5 },
          }),
        ],
      }),
      resolve
    );
    expect(spec.items.find((i) => i.start === 1)?.fadeIn).toBe(0);
  });

  test("an empty track 0 still runs the project's length as silence", () => {
    const spec = mixSpecFor(
      doc({ clips: [clip({ id: "c1", assetId: "a", track: 1, start: 0, out: 6 })] }),
      resolve
    );
    expect(spec.clips).toHaveLength(1);
    expect(spec.clips[0].file).toBe("");
    expect(spec.clips[0].muted).toBe(true);
  });
});

describe("bitrateFor", () => {
  test("spends more bits on a lower CRF", () => {
    const base = { width: 1920, height: 1080, fps: 30, preset: "medium" };
    expect(bitrateFor({ ...base, crf: 19 })).toBeGreaterThan(bitrateFor({ ...base, crf: 24 }));
  });

  test("scales with frame area", () => {
    const base = { fps: 30, crf: 23, preset: "medium" };
    expect(bitrateFor({ ...base, width: 1920, height: 1080 })).toBeGreaterThan(
      bitrateFor({ ...base, width: 1280, height: 720 })
    );
  });
});
