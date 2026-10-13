import { expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import type { MediaAsset } from "./types";

// measure_level says where a clip's loudest sample lands, on its own source
// clock and on the timeline, so a click can be put on a beat to the sample
// rather than probed for with silence thresholds 20 ms at a time.
await stubModule<typeof import("./media")>("./media", import.meta.url, {
  measureSourceLevel: (async () => ({
    rmsDb: -20,
    loudestFrameDb: -10,
    audibleSeconds: 0.2,
    peakAt: 0.639,
    samplePeakDb: -1.2,
    loudness: { integrated: -18, truePeak: -1, range: 2, momentaryMax: -12, shortTermMax: -14 },
  })) as never,
});

const { runAiTool } = await import("./aiTools");
const { useEditor } = await import("./store");

const sound: MediaAsset = { id: "key", fileName: "key.mp3", name: "key", type: "audio", duration: 0.9, url: "blob:key" };

test("measure_level reports when the loudest sample plays, in source and timeline seconds", async () => {
  useEditor.setState({
    projectId: "p1",
    loaded: true,
    readOnly: false,
    clips: [],
    audioClips: [{ id: "k", assetId: "key", start: 2, in: 0.6, out: 0.9, volume: 1 }],
    overlays: [],
    transitions: [],
    assets: [sound],
  });
  const res = (await runAiTool("measure_level", { ids: ["k"] })) as {
    clips: { id: string; loudestAt?: number; loudestAtTimeline?: number; samplePeakDb?: number }[];
  };
  expect(res.clips[0].loudestAt).toBeCloseTo(0.639, 3);
  expect(res.clips[0].loudestAtTimeline).toBeCloseTo(2.039, 3);
  expect(res.clips[0].samplePeakDb).toBe(-1.2);
});
