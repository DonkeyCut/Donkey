import { expect, test } from "bun:test";
import type { ExportDoc } from "@/cut/lib/renderSnapshot";

// The server's base video is a fold of the clip list, so every second the
// cut runs needs a segment in it: a cut whose sound outlasts its last shot
// carries black to the end.

const { buildExportPayload, originalSettings } = await import("./exportClient");

const doc: ExportDoc = {
  aspect: "16:9",
  assets: [
    { id: "v", fileName: "v.mp4", name: "V", type: "video", duration: 10, width: 1920, height: 1080, url: "",
      color: { matrix: "bt709", fullRange: false, bitDepth: 8, detected: "rec709" } },
    { id: "m", fileName: "m.mp3", name: "M", type: "audio", duration: 30, url: "" },
  ],
  clips: [{ id: "c1", assetId: "v", track: 0, start: 1, in: 0, out: 2, muted: false }],
  audioClips: [{ id: "a1", assetId: "m", start: 0, in: 0, out: 5, volume: 1 }],
  overlays: [],
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
};

test("the clip list runs to the end of the cut, black after the last shot", async () => {
  const settings = originalSettings(doc.aspect, doc.clips, doc.assets, doc);
  const payload = await buildExportPayload("project", doc, settings, "export");
  const spec = payload.spec as { duration: number; clips: { file: string; in: number; out: number }[] };
  expect(spec.duration).toBeCloseTo(5);
  expect(spec.clips.map((c) => c.file)).toEqual(["", "v.mp4", ""]);
  const length = spec.clips.reduce((sum, c) => sum + (c.out - c.in), 0);
  expect(length).toBeCloseTo(5);
});
