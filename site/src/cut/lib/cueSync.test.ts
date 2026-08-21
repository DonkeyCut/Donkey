import { beforeEach, describe, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { syncToSpeech } from "./cueSync";
import { useEditor } from "./store";
import { emptySubtitles, isTextOverlay, type SubtitleCue } from "./types";

/**
 * Re-timing what is already on the timeline onto the speech in the mix.
 *
 * The audio here is built the way cueAlign's own tests build it: noise bursts
 * where speech happens, quiet between them. What these check is the layer above
 * — that the move is reported honestly, that ids and words survive it, and that
 * a mix with nothing to read comes back saying so instead of claiming a fix.
 */

const RATE = 16000;

function mix(duration: number, spans: [number, number][]): Float32Array {
  const samples = new Float32Array(Math.round(duration * RATE));
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let i = 0; i < samples.length; i++) samples[i] = rnd() * 0.002;
  for (const [from, to] of spans) {
    const start = Math.round(from * RATE);
    const stop = Math.min(samples.length, Math.round(to * RATE));
    for (let i = start; i < stop; i++) samples[i] += rnd() * 0.6;
  }
  return samples;
}

const SPEECH: [number, number][] = [
  [1, 2.5],
  [4, 5.5],
  [8, 9.5],
];
const audio = () => mix(12, SPEECH);

const cue = (id: string, start: number, end: number, text = "a line of speech"): SubtitleCue => ({
  id,
  start,
  end,
  text,
});

describe("syncToSpeech", () => {
  test("moves late times onto the speech and reports the move", () => {
    const late = [cue("a", 1.3, 2.8), cue("b", 4.3, 5.8), cue("c", 8.3, 9.8)];
    const report = syncToSpeech(late, audio(), RATE);
    expect(report.evidence).toBe(true);
    expect(report.moved).toHaveLength(3);
    expect(report.items[0].start).toBeCloseTo(1, 1);
    expect(report.items[1].start).toBeCloseTo(4, 1);
    expect(report.items[2].start).toBeCloseTo(8, 1);
    // The report is what the assistant repeats back, so it has to describe the
    // move that actually happened.
    expect(report.maxShift).toBeGreaterThanOrEqual(report.medianShift);
    expect(report.moved.every((m) => m.shift < 0)).toBe(true);
  });

  test("ids, text and word timings ride through", () => {
    const withWords = [
      { ...cue("a", 1.3, 2.8), words: [{ t0: 1.3, t1: 2, w: "a" }, { t0: 2, t1: 2.8, w: "line" }] },
      cue("b", 4.3, 5.8),
      cue("c", 8.3, 9.8),
    ];
    const report = syncToSpeech(withWords, audio(), RATE);
    expect(report.items[0].id).toBe("a");
    expect(report.items[0].text).toBe("a line of speech");
    expect(report.items[0].words?.[0].t0).toBeCloseTo(1, 1);
    expect(report.items[0].words).toHaveLength(2);
  });

  test("times already on the speech move nothing", () => {
    const report = syncToSpeech([cue("a", 1, 2.5), cue("b", 4, 5.5)], audio(), RATE);
    expect(report.moved).toHaveLength(0);
    expect(report.evidence).toBe(true);
  });

  test("audio with nothing to read says so rather than claiming a fix", () => {
    const silent = new Float32Array(RATE * 12);
    const wall = mix(12, [[0, 12]]);
    for (const samples of [silent, wall]) {
      const report = syncToSpeech([cue("a", 1.3, 2.8)], samples, RATE);
      expect(report.evidence).toBe(false);
      expect(report.moved).toHaveLength(0);
      expect(report.items[0].start).toBe(1.3);
    }
  });

  test("one cue out of a long recording is not enough to read the mix by", () => {
    // The fit is weighed over the whole transcript: a single line against
    // twelve seconds of speech describes something else, so nothing moves.
    // This is why the tool measures a whole track even when writing a subset.
    expect(syncToSpeech([cue("a", 1.3, 2.8)], audio(), RATE).evidence).toBe(false);
  });

  test("nothing to align is not an alignment", () => {
    expect(syncToSpeech([], audio(), RATE).evidence).toBe(false);
  });
});

describe("align_to_audio", () => {
  const reset = (cues: SubtitleCue[], overlays: unknown[] = []) =>
    useEditor.setState({
      projectId: "p1",
      aspect: "16:9",
      assets: [],
      clips: [],
      audioClips: [],
      overlays: overlays as never,
      subtitles: { ...emptySubtitles(), cues },
      cutMixSamples: async () => ({ samples: audio(), sampleRate: RATE }),
    });

  const title = (id: string, start: number, end: number) => ({
    id,
    kind: "text" as const,
    text: `line ${id}`,
    start,
    end,
    x: 0.5,
    y: 0.5,
    size: 72,
    color: "#FFFFFF",
    font: "sf",
    weight: 700 as const,
  });

  beforeEach(() => reset([]));

  test("re-times a caption track in place, ids kept", async () => {
    reset([cue("a", 1.3, 2.8), cue("b", 4.3, 5.8), cue("c", 8.3, 9.8)]);
    const res = (await runAiTool("align_to_audio", {})) as {
      target: string;
      moved: number;
      evidence: boolean;
      items: { id: string; shift: number }[];
    };
    expect(res.target).toBe("captions");
    expect(res.evidence).toBe(true);
    expect(res.moved).toBe(3);
    const after = useEditor.getState().subtitles.cues;
    expect(after.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(after[0].start).toBeCloseTo(1, 1);
    expect(after[2].start).toBeCloseTo(8, 1);
    // One undo step puts every cue back where it was.
    useEditor.getState().undo();
    expect(useEditor.getState().subtitles.cues[0].start).toBeCloseTo(1.3, 2);
  });

  test("writing part of a track never lands a cue on a neighbour", async () => {
    // The whole track is measured, only `b` is written. `b` wants to move back
    // onto the speech at 4, and `a` — left where it is — still ends at 4.4.
    // Captions on a track may not overlap, so the write is fitted to the room
    // it actually has.
    reset([cue("a", 2.9, 4.4), cue("b", 4.3, 5.8), cue("c", 8.3, 9.8)]);
    await runAiTool("align_to_audio", { ids: ["b"] });
    const after = useEditor.getState().subtitles.cues;
    const by = new Map(after.map((c) => [c.id, c]));
    expect(by.get("a")!.start).toBeCloseTo(2.9, 2);
    expect(by.get("a")!.end).toBeCloseTo(4.4, 2);
    expect(by.get("c")!.start).toBeCloseTo(8.3, 2);
    expect(by.get("b")!.start).toBeGreaterThanOrEqual(by.get("a")!.end - 1e-6);
    for (const [i, c] of after.entries()) {
      if (i > 0) expect(c.start).toBeGreaterThanOrEqual(after[i - 1].end - 1e-6);
    }
  });

  test("a card rides only with a word that actually moved", async () => {
    // `t2` is the only element written, so `c1` — the card behind `t1` — must
    // stay with the word it belongs to rather than following an alignment
    // nobody applied.
    const card = (id: string, start: number, end: number) => ({
      id,
      kind: "rect" as const,
      start,
      end,
      x: 0.5,
      y: 0.5,
      w: 1,
      h: 1,
      fill: "#FF5500",
    });
    reset(
      [],
      [
        { ...title("t1", 1.3, 2.8), lane: 0 },
        { ...title("t2", 4.3, 5.8), lane: 0 },
        { ...card("c1", 1.3, 2.8), lane: 1 },
      ]
    );
    await runAiTool("align_to_audio", { target: "elements", ids: ["t2"] });
    const by = new Map(useEditor.getState().overlays.map((o) => [o.id, o]));
    expect(by.get("t1")!.start).toBeCloseTo(1.3, 2);
    expect(by.get("c1")!.start).toBeCloseTo(1.3, 2);
    expect(by.get("t2")!.start).toBeCloseTo(4, 1);
  });

  test("re-times the elements of a text run", async () => {
    reset([], [title("t1", 1.3, 2.8), title("t2", 4.3, 5.8), title("t3", 8.3, 9.8)]);
    const res = (await runAiTool("align_to_audio", { target: "elements" })) as {
      target: string;
      lane: number;
      moved: number;
    };
    expect(res.target).toBe("elements");
    expect(res.moved).toBe(3);
    const after = useEditor.getState().overlays.filter(isTextOverlay);
    expect(after.map((o) => o.id)).toEqual(["t1", "t2", "t3"]);
    expect(after[0].start).toBeCloseTo(1, 1);
    expect(after[1].start).toBeCloseTo(4, 1);
    // Elements on one row must never overlap, and an alignment is no exception.
    for (let i = 0; i + 1 < after.length; i++)
      expect(after[i].end).toBeLessThanOrEqual(after[i + 1].start + 1e-6);
  });

  test("a mix it cannot read leaves the cut alone and says so", async () => {
    reset([cue("a", 1.3, 2.8)]);
    useEditor.setState({
      cutMixSamples: async () => ({ samples: new Float32Array(RATE * 12), sampleRate: RATE }),
    });
    const res = (await runAiTool("align_to_audio", {})) as { evidence: boolean; moved: number };
    expect(res.evidence).toBe(false);
    expect(res.moved).toBe(0);
    expect(useEditor.getState().subtitles.cues[0].start).toBeCloseTo(1.3, 2);
  });

  const failure = async (input: Record<string, unknown>) => {
    try {
      await runAiTool("align_to_audio", input);
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  test("nothing to align, and nothing audible, are both refused", async () => {
    reset([]);
    expect(await failure({})).toContain("no captions");
    reset([cue("a", 1.3, 2.8)]);
    useEditor.setState({ cutMixSamples: async () => null });
    expect(await failure({})).toContain("audible");
  });

  test("a run's color cards ride with the words they sit behind", async () => {
    const card = (id: string, start: number, end: number) => ({
      id,
      kind: "rect" as const,
      start,
      end,
      x: 0.5,
      y: 0.5,
      w: 1,
      h: 1,
      fill: "#FF5500",
    });
    reset(
      [],
      [
        { ...title("t1", 1.3, 2.8), lane: 0 },
        { ...title("t2", 4.3, 5.8), lane: 0 },
        { ...card("c1", 1.3, 2.8), lane: 1 },
        { ...card("c2", 4.3, 5.8), lane: 1 },
      ]
    );
    await runAiTool("align_to_audio", { target: "elements" });
    const by = new Map(useEditor.getState().overlays.map((o) => [o.id, o]));
    expect(by.get("t1")!.start).toBeCloseTo(1, 1);
    expect(by.get("c1")!.start).toBeCloseTo(by.get("t1")!.start, 3);
    expect(by.get("c2")!.start).toBeCloseTo(by.get("t2")!.start, 3);
  });
});
