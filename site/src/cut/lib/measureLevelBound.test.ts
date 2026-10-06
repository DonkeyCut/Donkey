import { expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import type { MediaAsset } from "./types";

// measure_level hears a clip where it sounds: a video bound to a recording is
// measured off the recording, over the stretch the clip plays, on the
// recording's clock.
const reads: { url: string; from: number; to?: number }[] = [];

await stubModule<typeof import("./media")>("./media", import.meta.url, {
  measureSourceLevel: (async (url: string, opts: { from: number; to?: number }) => {
    reads.push({ url, ...opts });
    return {
      rmsDb: -20,
      loudestFrameDb: -10,
      audibleSeconds: 2,
      loudness: { integrated: -18, truePeak: -3, range: 4, momentaryMax: -12, shortTermMax: -14 },
    };
  }) as never,
});

const { runAiTool } = await import("./aiTools");
const { useEditor } = await import("./store");

const media = (id: string, type: "video" | "audio", over: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  fileName: `${id}.file`,
  name: id,
  type,
  duration: 60,
  url: `blob:${id}`,
  ...over,
});

test("measure_level reads the recording bound to the video, on the recording's clock", async () => {
  useEditor.setState({
    projectId: "p1",
    loaded: true,
    readOnly: false,
    clips: [{ id: "a", assetId: "cam", start: 0, in: 10, out: 14, track: 0, muted: false }],
    audioClips: [],
    overlays: [],
    transitions: [],
    assets: [media("cam", "video", { soundFrom: { assetId: "rec", offset: -4 } }), media("rec", "audio")],
  });
  const res = (await runAiTool("measure_level", { ids: ["a"] })) as { clips: { id: string; sourceDb: number }[] };
  expect(reads).toEqual([{ url: "blob:rec", from: 6, to: 10 }]);
  expect(res.clips[0].sourceDb).toBe(-20);

  reads.length = 0;
  useEditor.getState().setAssetSoundFrom("cam", undefined);
  await runAiTool("measure_level", { ids: ["a"] });
  expect(reads).toEqual([{ url: "blob:cam", from: 10, to: 14 }]);
});
