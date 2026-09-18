import { describe, expect, test } from "bun:test";
import { SETTINGS } from "@/lib/config/registry";
import {
  QUALITY_QUESTIONS,
  QUALITY_STEER_PREFIX,
  qualityState,
  qualityVerdict,
  recordLook,
  type QualityAnswers,
  type TurnWork,
  type WatchedSource,
} from "./turnQuality";

const settings = SETTINGS.cutJudge.default;

const source = (over: Partial<WatchedSource> = {}): WatchedSource => ({
  name: "reference.mp4",
  duration: 71.6,
  passes: 1,
  coveredTo: 20,
  unwatched: 51.6,
  unnoted: [{ from: 20, to: 71.6 }],
  observed: [{ from: 0, to: 20, text: "hook titles over a talking head" }],
  cuts: 12,
  ...over });

const work = (over: Partial<TurnWork> = {}): TurnWork => ({
  request: "replicate this video",
  reply: "Here is the whole video rebuilt.",
  ran: ["watch_video", "note_source"],
  failed: [],
  sources: [source()],
  editor: { clips: 0 },
  ...over });

function answers(over: {
  finished?: number;
  seen?: number;
  honest?: number;
  closeness?: "shape" | "normal" | "exact";
}): QualityAnswers {
  const closeness = over.closeness ?? "normal";
  return {
    finished: { type: "noul", noul: over.finished ?? 0.9 },
    seen: { type: "noul", noul: over.seen ?? 0.9 },
    honest: { type: "noul", noul: over.honest ?? 0.9 },
    closeness: {
      type: "choice",
      choice: closeness,
      probabilities: { shape: 0.1, normal: 0.1, exact: 0.1, [closeness]: 0.7 },
      confidence: 0.7,
    },
  } as unknown as QualityAnswers;
}

describe("qualityVerdict", () => {
  test("work that holds up closes the turn", () => {
    expect(qualityVerdict(answers({}), work(), settings)).toBeNull();
  });

  test("a judgment that could not be asked never holds a turn back", () => {
    expect(qualityVerdict(null, work(), settings)).toBeNull();
  });

  test("the gate off closes the turn whatever the answers say", () => {
    const verdict = qualityVerdict(answers({ finished: 0.05, seen: 0.05 }), work(), {
      ...settings,
      qualityGate: false });
    expect(verdict).toBeNull();
  });

  test("a source with footage nobody has seen sends the turn back to watching", () => {
    const verdict = qualityVerdict(answers({ seen: 0.1, closeness: "exact" }), work(), settings);
    expect(verdict?.step).toBe("watch");
    expect(verdict?.steer.startsWith(QUALITY_STEER_PREFIX)).toBe(true);
    // The instruction carries the real numbers: where coverage ends, and the
    // floor the ask needs.
    expect(verdict?.steer).toContain("from=20");
    expect(verdict?.steer).toContain("interval_seconds=0.5");
    expect(verdict?.steer).toContain("reference.mp4");
  });

  test("looking comes before building when both are short", () => {
    const verdict = qualityVerdict(answers({ finished: 0.1, seen: 0.1 }), work(), settings);
    expect(verdict?.step).toBe("watch");
  });

  test("a doubt with nothing measurable behind it lets the turn close", () => {
    // The source was watched through and every call landed: the judgment has
    // no gap to point at, and a turn sent back here would build twice.
    const seen = work({ sources: [source({ coveredTo: 71.6, unwatched: 0, unnoted: [] })] });
    expect(qualityVerdict(answers({ finished: 0.1 }), seen, settings)).toBeNull();
  });

  test("a failed call is named in the repair instruction", () => {
    const broken = work({
      sources: [source({ coveredTo: 71.6, unwatched: 0, unnoted: [] })],
      failed: ["add_title (no project open)"] });
    const verdict = qualityVerdict(answers({ finished: 0.2 }), broken, settings);
    expect(verdict?.step).toBe("repair");
    expect(verdict?.steer).toContain("add_title (no project open)");
  });

  test("a reply wider than the record sends the turn back to the footage", () => {
    // Describing the whole of a source seen in part: the unseen seconds are
    // the measurable gap the hold points at.
    const verdict = qualityVerdict(answers({ honest: 0.1 }), work(), settings);
    expect(verdict?.step).toBe("watch");
  });

  test("a turn that opened no source is never held", () => {
    expect(
      qualityVerdict(answers({ finished: 0.1, seen: 0.1 }), work({ sources: [] }), settings),
    ).toBeNull();
  });

  test("the steer names what the turn already built, so it carries on instead of starting over", () => {
    const mid = work({ editor: { clips: 36, overlayKinds: ["text"] } });
    const verdict = qualityVerdict(answers({ seen: 0.1 }), mid, settings);
    expect(verdict?.steer).toContain("36 clips");
    expect(verdict?.steer).toContain("doubles the cut");
  });
});

describe("qualityState", () => {
  test("carries the ask, the record and the editor, with the notes capped", () => {
    const state = qualityState(
      work({ sources: [source({ observed: [{ from: 0, to: 20, text: "x".repeat(2000) }] })] }),
    ) as {
      request: string;
      sources: { secondsNeverSeen: number; observed: { text: string }[] }[];
      editor: unknown;
    };
    expect(state.request).toBe("replicate this video");
    expect(state.sources[0].secondsNeverSeen).toBe(51.6);
    expect(state.sources[0].observed[0].text.length).toBeLessThanOrEqual(600);
    expect(state.editor).toEqual({ clips: 0 });
  });
});

describe("recordLook", () => {
  test("a watch pass records coverage, cuts and the notes already written", () => {
    const looks = new Map<string, WatchedSource>();
    recordLook(looks, "watch_video", {
      source: { assetId: "a1", name: "reference.mp4", duration: 71.6 },
      coveredTo: 20,
      unwatchedSeconds: 51.6,
      sceneChanges: [1, 4.25, 6.5],
      recorded: [{ from: 0, to: 20, text: "the hook" }],
      unnoted: [{ from: 20, to: 71.6 }] });
    recordLook(looks, "watch_video", {
      source: { assetId: "a1", name: "reference.mp4", duration: 71.6 },
      coveredTo: 45,
      unwatchedSeconds: 26.6,
      sceneChanges: [21, 24],
      unnoted: [{ from: 45, to: 71.6 }] });
    const rec = looks.get("a1")!;
    expect(rec.passes).toBe(2);
    expect(rec.coveredTo).toBe(45);
    expect(rec.unwatched).toBe(26.6);
    expect(rec.cuts).toBe(5);
    expect(rec.unnoted).toEqual([{ from: 45, to: 71.6 }]);
  });

  test("note_source replaces the record with the whole written one", () => {
    const looks = new Map<string, WatchedSource>();
    recordLook(looks, "note_source", {
      source: { assetId: "a1", name: "reference.mp4", duration: 71.6 },
      notes: [
        { from: 0, to: 20, text: "the hook" },
        { from: 20, to: 45, text: "the split screen" },
      ],
      unnoted: [] });
    expect(looks.get("a1")!.observed).toHaveLength(2);
    expect(looks.get("a1")!.unnoted).toEqual([]);
  });

  test("anything that is not a look is ignored", () => {
    const looks = new Map<string, WatchedSource>();
    recordLook(looks, "add_title", { source: { assetId: "a1" } });
    recordLook(looks, "watch_video", { note: "no source here" });
    expect(looks.size).toBe(0);
  });
});

describe("QUALITY_QUESTIONS", () => {
  test("asks whether the work is finished, seen, honest, and what comes next", () => {
    expect(Object.keys(QUALITY_QUESTIONS)).toEqual([
      "finished",
      "seen",
      "honest",
      "closeness",
    ]);
  });
});
