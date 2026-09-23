import { expect, test } from "bun:test";
import { choiceSettings, EXPORT_QUICK_PRESETS, originalSettings, resolutionOptions, buildExportPayload } from "@/cut/lib/exportClient";
import { sourceExportPlan, sourceSequence } from "@/cut/lib/sourceExportPlan";
import type { ExportDoc } from "@/cut/lib/renderSnapshot";
import type { VideoClip } from "@/cut/lib/types";

const doc: ExportDoc = {
  aspect: "16:9", assets: [{ id: "source", fileName: "source.mp4", name: "Source", type: "video", duration: 904, width: 320, height: 240, url: "" }],
  clips: [{ id: "clip", assetId: "source", track: 0, start: 0, in: 15.137, out: 870.437, muted: false }],
  audioClips: [], overlays: [], subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
};
const settings = originalSettings(doc.aspect, doc.clips, doc.assets, doc);

test("a plain trim preserves the source frame and exact source window", async () => {
  expect(settings).toMatchObject({ width: 320, height: 240, copySource: true });
  expect(sourceExportPlan(doc, settings)).toEqual([{ file: "source.mp4", from: 15.137, to: 870.437 }]);
  const payload = await buildExportPayload("project", doc, settings, "export");
  expect(payload.spec).toMatchObject({ sourceSegments: [{ file: "source.mp4", from: 15.137, to: 870.437 }] });
  expect("sourceSegments" in (await buildExportPayload("project", doc, settings, "preview")).spec).toBe(false);
});

test("selection ranges resolve inside the original trim", () => {
  expect(sourceExportPlan(doc, { ...settings, range: { start: 3, end: 8 } }))
    .toEqual([{ file: "source.mp4", from: 18.137, to: 23.137 }]);
  expect(sourceExportPlan(doc, { ...settings, range: { start: 900, end: 950 } })).toBeNull();
});

test("explicit delivery choices keep rendering", () => {
  const options = resolutionOptions(doc.aspect, doc.clips, doc.assets, doc);
  const best = EXPORT_QUICK_PRESETS[1].choice;
  expect(sourceExportPlan(doc, choiceSettings(best, options))).not.toBeNull();
  for (const choice of [{ ...best, fps: 24 }, { ...best, bitrateMbps: 1 }, { ...best, quality: "small" as const }, EXPORT_QUICK_PRESETS[0].choice, EXPORT_QUICK_PRESETS[4].choice]) {
    expect(sourceExportPlan(doc, choiceSettings(choice, options))).toBeNull();
  }
});

test("picture, timing and audio treatments require the compositor", () => {
  const changes: Partial<VideoClip>[] = [
    { start: 1 }, { muted: true }, { volume: 0.5 }, { fit: "fill" }, { zoom: 1.1 },
    { rotation: 90 }, { flipH: true }, { speed: 2 }, { reverse: true }, { hidden: true },
    { opacity: 0.5 }, { transition: 1 }, { frame: { x: 0, y: 0, w: 0.5, h: 1 } },
    { grade: { exposure: 1 } }, { kf: [] },
  ];
  for (const change of changes) expect(sourceSequence({ ...doc, clips: [{ ...doc.clips[0], ...change }] })).toBeNull();
  expect(sourceSequence({ ...doc, clips: [...doc.clips, doc.clips[0]] })).toBeNull();
  expect(sourceSequence({ ...doc, audioClips: [{ id: "a", assetId: "source", start: 0, in: 0, out: 3, volume: 1 }] })).toBeNull();
});

test("whole files, contiguous splits and reordered sequences produce source plans", () => {
  const clip = { ...doc.clips[0], in: 0, out: 10 };
  expect(sourceExportPlan({ ...doc, clips: [clip] }, settings)).toEqual([{ file: "source.mp4", from: 0, to: 10 }]);
  const split = { ...doc, clips: [{ ...clip, out: 3.137 }, { ...clip, id: "split", in: 3.137, start: 3.137 }] };
  expect(sourceExportPlan(split, settings)).toEqual([{ file: "source.mp4", from: 0, to: 10 }]);
  const sequence = { ...doc, clips: [{ ...clip, in: 4, out: 8 }, { ...clip, id: "second", start: 4, out: 2 }] };
  expect(sourceExportPlan(sequence, settings)).toEqual([{ file: "source.mp4", from: 4, to: 8 }, { file: "source.mp4", from: 0, to: 2 }]);
  expect(sourceExportPlan(sequence, { ...settings, range: { start: 2, end: 5 } })).toEqual([{ file: "source.mp4", from: 6, to: 8 }, { file: "source.mp4", from: 0, to: 1 }]);
});
