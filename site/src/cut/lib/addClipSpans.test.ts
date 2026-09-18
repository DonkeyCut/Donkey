import { beforeEach, describe, expect, test } from "bun:test";

import { runAiTool } from "./aiTools";
import { clipLen, useEditor } from "./store";
import type { MediaAsset } from "./types";

/** add_clip with `spans`: several stretches of one source laid down in order,
 * with the material between them left out. This is the one path in the
 * clipping work that writes to the timeline, and the moments it places come
 * from a judgment, so the placement itself has to be exact. */

const source = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: "src",
  fileName: "talk.mp4",
  name: "talk.mp4",
  type: "video",
  duration: 120,
  url: "",
  ...over,
});

const track0 = () =>
  useEditor
    .getState()
    .clips.filter((c) => c.track === 0)
    .sort((a, b) => a.start - b.start);

beforeEach(() => {
  useEditor.setState({
    projectId: "p1",
    loaded: true,
    clips: [],
    transitions: [],
    audioClips: [],
    overlays: [],
    assets: [source()],
    selection: null,
    multiSelection: [],
  });
});

describe("add_clip spans", () => {
  test("each span becomes its own clip, trimmed to itself", async () => {
    await runAiTool("add_clip", {
      asset_id: "src",
      spans: [
        { from: 30, to: 60 },
        { from: 90, to: 115 },
      ],
    });
    const clips = track0();
    expect(clips.length).toBe(2);
    expect(clips.map((c) => [c.in, c.out])).toEqual([
      [30, 60],
      [90, 115],
    ]);
    expect(clips.map((c) => Math.round(clipLen(c)))).toEqual([30, 25]);
  });

  test("the clips sit end to end with nothing between them", async () => {
    // The material between two moments is what the cut leaves out, so the
    // second one starts where the first ends, not where it sat in the source.
    await runAiTool("add_clip", {
      asset_id: "src",
      spans: [
        { from: 10, to: 20 },
        { from: 80, to: 95 },
      ],
    });
    const [first, second] = track0();
    expect(second.start).toBeCloseTo(first.start + clipLen(first), 2);
  });

  test("spans land in source order whatever order they arrive in", async () => {
    await runAiTool("add_clip", {
      asset_id: "src",
      spans: [
        { from: 90, to: 115 },
        { from: 30, to: 60 },
      ],
    });
    expect(track0().map((c) => c.in)).toEqual([30, 90]);
  });

  test("a span reaching past the source is clamped to it", async () => {
    await runAiTool("add_clip", { asset_id: "src", spans: [{ from: 110, to: 400 }] });
    const [only] = track0();
    expect(only.out).toBe(120);
    expect(only.in).toBe(110);
  });

  test("a backwards span is read as the stretch it names", async () => {
    await runAiTool("add_clip", { asset_id: "src", spans: [{ from: 60, to: 30 }] });
    expect(track0().map((c) => [c.in, c.out])).toEqual([[30, 60]]);
  });

  test("the whole run is one undo step", async () => {
    await runAiTool("add_clip", {
      asset_id: "src",
      spans: [
        { from: 10, to: 20 },
        { from: 30, to: 40 },
        { from: 50, to: 60 },
      ],
    });
    expect(track0().length).toBe(3);
    useEditor.getState().undo();
    expect(track0().length).toBe(0);
  });

  test("the result reports what it laid down", async () => {
    const out = (await runAiTool("add_clip", {
      asset_id: "src",
      spans: [
        { from: 10, to: 20 },
        { from: 30, to: 45 },
      ],
    })) as { clips: { id: string; in: number; out: number; len: number }[]; seconds: number };
    expect(out.clips.map((c) => c.len)).toEqual([10, 15]);
    expect(out.seconds).toBe(25);
    expect(new Set(out.clips.map((c) => c.id)).size).toBe(2);
  });

  test("empty and out-of-range spans are refused, not silently dropped", async () => {
    await expect(
      runAiTool("add_clip", { asset_id: "src", spans: [{ from: 50, to: 50 }] })
    ).rejects.toThrow();
    expect(track0().length).toBe(0);
  });

  test("an audio source has no spans to cut", async () => {
    useEditor.setState({ assets: [source({ type: "audio", fileName: "music.mp3" })] });
    await expect(
      runAiTool("add_clip", { asset_id: "src", spans: [{ from: 0, to: 10 }] })
    ).rejects.toThrow();
  });

  test("a still has no time axis to cut spans out of", async () => {
    useEditor.setState({ assets: [source({ type: "image", fileName: "shot.png" })] });
    await expect(
      runAiTool("add_clip", { asset_id: "src", spans: [{ from: 0, to: 10 }] })
    ).rejects.toThrow();
  });
});
