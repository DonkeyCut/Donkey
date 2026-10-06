import { beforeEach, describe, expect, test } from "bun:test";

import { runAiTool } from "./aiTools";
import { soundWindow } from "./soundSource";
import { getClipSpans, useEditor } from "./store";
import type { MediaAsset, VideoClip } from "./types";

/** Split edits and bound recordings as the document holds them: what the
 * spans every renderer reads make of a clip's lead, tail and recording, and
 * how the edits that reshape clips carry them. */

const video = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: "cam",
  fileName: "cam.mp4",
  name: "cam.mp4",
  type: "video",
  duration: 60,
  url: "",
  ...over,
});
const recording: MediaAsset = { id: "rec", fileName: "rec.wav", name: "rec.wav", type: "audio", duration: 50, url: "" };

const clip = (id: string, start: number, inS: number, outS: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id,
  assetId: "cam",
  start,
  in: inS,
  out: outS,
  track: 0,
  muted: false,
  ...over,
});

const spanOf = (id: string) => {
  const s = useEditor.getState();
  return getClipSpans(s.clips, s.assets).find((sp) => sp.clip.id === id)!;
};

beforeEach(() => {
  useEditor.setState({
    projectId: "p1",
    loaded: true,
    readOnly: false,
    clips: [clip("a", 0, 10, 14), clip("b", 4, 20, 24)],
    transitions: [],
    audioClips: [],
    overlays: [],
    assets: [video(), recording],
    selection: null,
    multiSelection: [],
  });
});

describe("set_split_edit", () => {
  test("a lead and a tail reach past the picture and nothing moves", async () => {
    await runAiTool("set_split_edit", { clipId: "b", lead: 0.4 });
    await runAiTool("set_split_edit", { clipId: "a", tail: 0.6 });
    const b = spanOf("b");
    const a = spanOf("a");
    expect(b.soundLead).toBeCloseTo(0.4, 5);
    expect(b.soundBack).toBeCloseTo(0.4, 5);
    expect(a.soundTail).toBeCloseTo(0.6, 5);
    expect(a.soundAhead).toBeCloseTo(0.6, 5);
    expect(b.start).toBe(4);
    expect(b.len).toBe(4);
  });

  test("a lead is capped by the source before the trim and by the timeline's start", async () => {
    useEditor.setState({ clips: [clip("a", 1, 0.3, 4)] });
    const res = (await runAiTool("set_split_edit", { clipId: "a", lead: 2 })) as { playing: { lead: number }; note?: string };
    expect(spanOf("a").soundLead).toBeCloseTo(0.3, 5);
    expect(res.playing.lead).toBeCloseTo(0.3, 2);
    expect(res.note).toBeDefined();
  });

  test("a cut carrying a transition keeps no split edit on that side", async () => {
    await runAiTool("set_split_edit", { clipId: "b", lead: 0.4 });
    expect(spanOf("b").soundLead).toBeCloseTo(0.4, 5);
    await runAiTool("set_transition", { clipId: "a", seconds: 0.5 });
    expect(spanOf("a").transitionOut).toBeGreaterThan(0);
    expect(spanOf("b").soundLead ?? 0).toBe(0);
    // The setting stays on the clip, and plays again once the cut is plain.
    await runAiTool("set_transition", { clipId: "a", seconds: 0 });
    expect(spanOf("b").soundLead).toBeCloseTo(0.4, 5);
  });

  test("0 clears a side and a side left out keeps its value", async () => {
    await runAiTool("set_split_edit", { clipId: "b", lead: 0.4, tail: 0.3 });
    await runAiTool("set_split_edit", { clipId: "b", lead: 0 });
    const b = useEditor.getState().clips.find((c) => c.id === "b")!;
    expect(b.audioLead).toBeUndefined();
    expect(b.audioTail).toBeCloseTo(0.3, 5);
  });

  test("a split keeps the lead on the left half and the tail on the right", async () => {
    await runAiTool("set_split_edit", { clipId: "b", lead: 0.4, tail: 0.3 });
    await runAiTool("split_at", { t: 6 });
    const halves = useEditor
      .getState()
      .clips.filter((c) => c.start >= 4)
      .sort((x, y) => x.start - y.start);
    expect(halves).toHaveLength(2);
    expect(halves[0].audioLead).toBeCloseTo(0.4, 5);
    expect(halves[0].audioTail).toBeUndefined();
    expect(halves[1].audioLead).toBeUndefined();
    expect(halves[1].audioTail).toBeCloseTo(0.3, 5);
  });

  test("ids lands one split edit on several clips", async () => {
    await runAiTool("set_split_edit", { ids: ["a", "b"], tail: 0.2 });
    const s = useEditor.getState();
    expect(s.clips.every((c) => c.audioTail === 0.2)).toBe(true);
  });
});

describe("a recording bound to the video", () => {
  test("every clip of the video reads it, a split's halves included", async () => {
    useEditor.getState().setAssetSoundFrom("cam", { assetId: "rec", offset: -5 });
    await runAiTool("split_at", { t: 2 });
    const s = useEditor.getState();
    const spans = getClipSpans(s.clips, s.assets);
    expect(spans).toHaveLength(3);
    for (const sp of spans) {
      expect(sp.sound?.asset.id).toBe("rec");
      expect(sp.sound?.offset).toBe(-5);
    }
  });

  test("the recording's own room bounds the handles", () => {
    // The recording starts at video second 5; clip a starts on video 10, so
    // five seconds of it sit before the trim.
    useEditor.setState({ clips: [clip("a", 8, 10, 14, { audioLead: 9 })] });
    useEditor.getState().setAssetSoundFrom("cam", { assetId: "rec", offset: -5 });
    expect(spanOf("a").soundLead).toBeCloseTo(5, 5);
  });

  test("a window the recording does not reach narrows and starts late", () => {
    // Recording second = video second − 12: video 10..12 is before it rolled.
    const w = soundWindow({ in: 10, out: 14 }, { offset: -12, limit: 50 }, 0, 4)!;
    expect(w.lo).toBe(0);
    expect(w.hi).toBeCloseTo(2, 5);
    expect(w.at).toBeCloseTo(2, 5);
  });

  test("binding is one undo step, and removing the recording unbinds", async () => {
    useEditor.getState().setAssetSoundFrom("cam", { assetId: "rec", offset: 1.5 });
    expect(useEditor.getState().assets.find((a) => a.id === "cam")!.soundFrom).toEqual({ assetId: "rec", offset: 1.5 });
    useEditor.getState().undo();
    expect(useEditor.getState().assets.find((a) => a.id === "cam")!.soundFrom).toBeUndefined();
    useEditor.getState().redo();
    expect(useEditor.getState().assets.find((a) => a.id === "cam")!.soundFrom?.assetId).toBe("rec");
    useEditor.getState().removeAsset("rec");
    expect(useEditor.getState().assets.find((a) => a.id === "cam")!.soundFrom).toBeUndefined();
  });

  test("sync_audio clear returns the video to its own sound", async () => {
    useEditor.getState().setAssetSoundFrom("cam", { assetId: "rec", offset: 1 });
    await runAiTool("sync_audio", { clipId: "a", clear: true });
    expect(useEditor.getState().assets.find((a) => a.id === "cam")!.soundFrom).toBeUndefined();
    expect(spanOf("a").sound).toBeUndefined();
  });

  test("sync_audio refuses a file that is not audio", async () => {
    await expect(runAiTool("sync_audio", { clipId: "a", audio_asset_id: "cam" })).rejects.toThrow();
  });
});
