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
  kind: "video",
  sound: "yes",
  passes: 1,
  coveredTo: 20,
  unwatched: 51.6,
  unnoted: [{ from: 20, to: 71.6 }],
  unread: 71.6,
  unreadFrom: 0,
  unheard: 0,
  unheardFrom: null,
  spoken: "",
  observed: [{ from: 0, to: 20, text: "hook titles over a talking head" }],
  cuts: 12,
  compared: 0,
  ...over });

const work = (over: Partial<TurnWork> = {}): TurnWork => ({
  request: "replicate this video",
  reply: "Here is the whole video rebuilt.",
  ran: ["watch_video", "note_source"],
  failed: [],
  mutated: true,
  sources: [source()],
  editor: { clips: 0 },
  ...over });

function answers(over: {
  finished?: number;
  seen?: number;
  honest?: number;
  hears?: number;
  captionsSpeak?: number;
  closeness?: "shape" | "normal" | "exact";
}): QualityAnswers {
  const closeness = over.closeness ?? "normal";
  return {
    finished: { type: "noul", noul: over.finished ?? 0.9 },
    seen: { type: "noul", noul: over.seen ?? 0.9 },
    honest: { type: "noul", noul: over.honest ?? 0.9 },
    hears: { type: "noul", noul: over.hears ?? 0.1 },
    captionsSpeak: { type: "noul", noul: over.captionsSpeak ?? 0.1 },
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

  test("an ask about how it sounds holds on seconds nobody played", () => {
    const unplayed = work({
      request: "cut this to the beat",
      sources: [source({ coveredTo: 71.6, unwatched: 0, unnoted: [], unread: 0, unheard: 71.6, unheardFrom: 0 })] });
    const verdict = qualityVerdict(answers({ honest: 0.1, hears: 0.9 }), unplayed, settings);
    expect(verdict?.step).toBe("watch");
    expect(verdict?.steer).toContain("listen_audio from=0");
    expect(verdict?.steer).toContain("71.6s");
  });

  test("a picture ask never holds on unplayed seconds", () => {
    const unplayed = work({
      sources: [source({ coveredTo: 71.6, unwatched: 0, unnoted: [], unread: 0, unheard: 71.6, unheardFrom: 0 })] });
    expect(qualityVerdict(answers({ honest: 0.1, hears: 0.1 }), unplayed, settings)).toBeNull();
  });

  test("a listen records what the source has left unheard", () => {
    const looks = new Map<string, WatchedSource>();
    recordLook(looks, "listen_audio", {
      source: { assetId: "a1", name: "track.mp3", duration: 200 },
      from: 0, coveredTo: 120, unheardSeconds: 80, unheardFrom: 120 });
    expect(looks.get("a1")!.unheard).toBe(80);
    expect(looks.get("a1")!.unheardFrom).toBe(120);
  });

  test("an exact ask holds on footage surveyed but never read", () => {
    // Every second has been looked at — as contact-sheet thumbnails, where a
    // caption is a few pixels tall. For an ask to reproduce the source, that
    // is a measured gap, the same as seconds nobody opened.
    const surveyed = work({ sources: [source({ coveredTo: 71.6, unwatched: 0, unnoted: [] })] });
    const verdict = qualityVerdict(answers({ honest: 0.1, closeness: "exact" }), surveyed, settings);
    expect(verdict?.step).toBe("watch");
    expect(verdict?.steer).toContain("detail=original");
    expect(verdict?.steer).toContain("71.6s");
    // The instruction names where to start, so following it ends the hold.
    expect(verdict?.steer).toContain("from=0");
  });

  test("a caption track that speaks is read for treatment, not for words", () => {
    // The text on screen is the narration, so the transcript already holds
    // every word of it. The close read that remains is about how they are
    // set, and the steer says so instead of asking for all 71.6s back.
    const surveyed = work({
      sources: [source({ coveredTo: 71.6, unwatched: 0, unnoted: [], spoken: '[0s-2s] "having to"' })],
    });
    const verdict = qualityVerdict(
      answers({ honest: 0.1, closeness: "exact", captionsSpeak: 0.9 }),
      surveyed,
      settings,
    );
    expect(verdict?.step).toBe("watch");
    expect(verdict?.steer).toContain("detail=original");
    expect(verdict?.steer).toContain("the transcript already holds the words");
  });

  test("a sample of a spoken caption track is enough to close an exact turn", () => {
    // Treatment reads as a sample, not as coverage: once enough of it has
    // been read closely, the rest comes off the transcript.
    const sampled = work({
      sources: [
        source({
          coveredTo: 71.6,
          unwatched: 0,
          unnoted: [],
          unread: 71.6 - settings.qualityTreatmentSeconds,
          unreadFrom: 10,
          compared: 2,
        }),
      ],
    });
    expect(
      qualityVerdict(
        answers({ honest: 0.1, closeness: "exact", captionsSpeak: 0.9 }),
        sampled,
        settings,
      ),
    ).toBeNull();
    // Text of its own still owes the full read-through.
    expect(
      qualityVerdict(
        answers({ honest: 0.1, closeness: "exact", captionsSpeak: 0.1 }),
        sampled,
        settings,
      )?.steer,
    ).toContain("until unreadSeconds is 0");
  });

  test("a source read closely end to end closes an exact turn", () => {
    // The measure rides the asset, so a source read in an earlier turn is not
    // charged for again.
    const read = work({
      sources: [
        source({ coveredTo: 71.6, unwatched: 0, unnoted: [], unread: 0, unreadFrom: null, compared: 2 }),
      ] });
    expect(qualityVerdict(answers({ honest: 0.1, closeness: "exact" }), read, settings)).toBeNull();
  });

  test("a normal ask never holds on detail", () => {
    const surveyed = work({ sources: [source({ coveredTo: 71.6, unwatched: 0, unnoted: [] })] });
    expect(qualityVerdict(answers({ honest: 0.1, closeness: "normal" }), surveyed, settings)).toBeNull();
  });

  test("a steer never names a tool the source refuses", () => {
    // The music the turn listened to has no picture. Steering watch_video at
    // it spends the round on "that is audio — listen_audio hears it".
    const music = work({
      request: "cut this to the beat",
      sources: [
        source({
          name: "track.mp3",
          kind: "audio",
          sound: "yes",
          duration: 200,
          coveredTo: 0,
          unwatched: 200,
          unread: 200,
          unreadFrom: 0,
          unheard: 0,
          unheardFrom: null,
          unnoted: [],
        }),
      ],
    });
    expect(qualityVerdict(answers({ finished: 0.1, closeness: "exact" }), music, settings)).toBeNull();
  });

  test("silent footage is never sent to be listened to", () => {
    // A generated b-roll clip with no audio track: listen_audio throws on it,
    // so an ask about the sound looks elsewhere.
    const silent = work({
      request: "cut this to the music",
      sources: [
        source({
          kind: "video",
          sound: "none",
          coveredTo: 71.6,
          unwatched: 0,
          unnoted: [],
          unread: 0,
          unreadFrom: null,
          unheard: 71.6,
          unheardFrom: 0,
        }),
      ],
    });
    expect(qualityVerdict(answers({ honest: 0.1, hears: 0.9 }), silent, settings)).toBeNull();
  });

  test("a gap too small to reach closes the turn", () => {
    // 98.6s of a 100s track played, the rest a sliver the coverage maths does
    // not report. With nowhere to send the next pass, a hold would replay the
    // whole source for seconds nobody can reach.
    const sliver = work({
      sources: [
        source({
          coveredTo: 71.6,
          unwatched: 0,
          unnoted: [],
          unread: 1.4,
          unreadFrom: null,
          compared: 2,
          unheard: 1.4,
          unheardFrom: null,
        }),
      ],
    });
    expect(qualityVerdict(answers({ honest: 0.1, hears: 0.9, closeness: "exact" }), sliver, settings)).toBeNull();
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

  test("a turn that opened no source and did the work is never held", () => {
    expect(
      qualityVerdict(answers({ finished: 0.1, seen: 0.1 }), work({ sources: [] }), settings),
    ).toBeNull();
  });




  test("a replica nobody held against its source is sent back to check it", () => {
    const blind = work({
      sources: [source({ observed: [{ from: 0, to: 60, text: "titles and shapes throughout" }], unwatched: 0, unread: 0, unreadFrom: null })],
      editor: { clips: 40, overlayKinds: ["text"] },
    });
    const verdict = qualityVerdict(answers({ finished: 0.2, closeness: "exact" }), blind, settings);
    expect(verdict?.step).toBe("check");
    expect(verdict?.steer).toContain("compare_to_source");
  });




  test("only the source the cut was copied from is owed a comparison", () => {
    // The reference is checked; the user's own footage the turn also watched
    // is not the thing the cut is being held up against.
    const both = work({
      sources: [
        source({ observed: [{ from: 0, to: 60, text: "the reference end to end" }], unwatched: 0, unread: 0, unreadFrom: null, compared: 3 }),
        source({ name: "My kitchen clip", duration: 12, observed: [{ from: 0, to: 12, text: "chopping" }], unwatched: 0, unread: 0, unreadFrom: null, compared: 0 }),
      ],
      editor: { clips: 40, overlayKinds: ["text"] },
    });
    expect(qualityVerdict(answers({ finished: 0.2, closeness: "exact" }), both, settings)).toBeNull();
  });

  test("a shell of colour blocks has no picture to hold up against the source", () => {
    // Every shot is a slot waiting for the person's own footage, so every
    // difference from the reference is the footage they bring.
    const shell = work({
      sources: [source({ observed: [{ from: 0, to: 60, text: "the reference end to end" }], unwatched: 0, unread: 0, unreadFrom: null })],
      editor: { clips: 40, emptyShots: 40, overlayKinds: [] },
    });
    expect(qualityVerdict(answers({ finished: 0.2, closeness: "exact" }), shell, settings)).toBeNull();
  });

  test("one shot with a picture in it is enough to check", () => {
    const partly = work({
      sources: [source({ observed: [{ from: 0, to: 60, text: "the reference end to end" }], unwatched: 0, unread: 0, unreadFrom: null })],
      editor: { clips: 40, emptyShots: 39, overlayKinds: [] },
    });
    expect(qualityVerdict(answers({ finished: 0.2, closeness: "exact" }), partly, settings)?.step).toBe("check");
  });

  test("a source already checked is not sent back to check it again", () => {
    const seen = work({
      sources: [source({ observed: [{ from: 0, to: 60, text: "x" }], unwatched: 0, unread: 0, unreadFrom: null, compared: 4 })],
      editor: { clips: 40, overlayKinds: ["text"] },
    });
    expect(qualityVerdict(answers({ finished: 0.2, closeness: "exact" }), seen, settings)).toBeNull();
  });

  test("an ask that never needed the source read frame by frame is not sent to check", () => {
    const loose = work({
      sources: [source({ observed: [{ from: 0, to: 60, text: "x" }], unwatched: 0, unread: 0, unreadFrom: null })],
      editor: { clips: 40, overlayKinds: ["text"] },
    });
    expect(qualityVerdict(answers({ finished: 0.2, closeness: "normal" }), loose, settings)).toBeNull();
  });

  test("nothing built yet is a build to finish, never a comparison to make", () => {
    const bare = work({
      sources: [source({ observed: [{ from: 0, to: 60, text: "x" }], unwatched: 0, unread: 0, unreadFrom: null })],
      editor: { clips: 0 },
      mutated: false,
    });
    expect(qualityVerdict(answers({ finished: 0.2, closeness: "exact" }), bare, settings)?.step).toBe("build");
  });

  test("an ask for work answered in words goes back to build it", () => {
    const words = work({ sources: [], mutated: false, ran: ["get_state"], reply: "The template is set up." });
    const verdict = qualityVerdict(answers({ finished: 0.2 }), words, settings);
    expect(verdict?.step).toBe("build");
    expect(verdict?.steer).toContain("Build it with tools now");
  });

  test("a turn that changed nothing because nothing was asked for closes", () => {
    const chat = work({ sources: [], mutated: false, ran: ["get_state"] });
    expect(qualityVerdict(answers({ finished: 0.9 }), chat, settings)).toBeNull();
  });

  test("a turn that asked the one question an ambiguous ask earns is not sent to build", () => {
    // The gate engages on a turn that changed nothing; what keeps a question
    // from being ordered to guess is the judge answering finished true, which
    // is the case the question spells out.
    const asked = work({
      sources: [],
      mutated: false,
      ran: [],
      request: "make it pop",
      reply: "Do you mean the titles or the cuts?",
    });
    expect(qualityVerdict(answers({ finished: 0.9 }), asked, settings)).toBeNull();
  });

  test("the build steer carries what already stands, so the second pass adds to it", () => {
    const partial = work({ sources: [], mutated: false, editor: { clips: 32, overlayKinds: ["text"] } });
    expect(qualityVerdict(answers({ finished: 0.2 }), partial, settings)?.steer).toContain("32 clips");
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
  test("a pass carries the source's own unread measure, not this turn's", () => {
    const looks = new Map<string, WatchedSource>();
    const src = { assetId: "a1", name: "reference.mp4", duration: 71.6 };
    recordLook(looks, "watch_video", {
      source: src, from: 0, coveredTo: 24, detail: "scan", unreadSeconds: 71.6, unreadFrom: 0 });
    expect(looks.get("a1")!.unread).toBe(71.6);
    recordLook(looks, "watch_video", {
      source: src, from: 0, coveredTo: 12, detail: "original", unreadSeconds: 59.6, unreadFrom: 12 });
    expect(looks.get("a1")!.unread).toBe(59.6);
    expect(looks.get("a1")!.unreadFrom).toBe(12);
  });

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

  test("a comparison counts the moments it checked against a source already seen", () => {
    const looks = new Map<string, WatchedSource>();
    recordLook(looks, "watch_video", {
      source: { assetId: "a1", name: "reference.mp4", duration: 71.6, type: "video", sound: "yes" },
      coveredTo: 71.6,
      unwatchedSeconds: 0,
      unreadSeconds: 0,
      unreadFrom: null,
    });
    recordLook(looks, "compare_to_source", {
      source: { assetId: "a1", name: "reference.mp4", duration: 71.6, type: "video", sound: "yes" },
      checked: [{ at: 1, source: 1 }, { at: 8, source: 8 }],
    });
    expect(looks.get("a1")!.compared).toBe(2);
    // A comparison reports no coverage, so it must not undo what watching read.
    expect(looks.get("a1")!.unwatched).toBe(0);
  });

  test("a comparison alone opens no record, because it says nothing about coverage", () => {
    const looks = new Map<string, WatchedSource>();
    recordLook(looks, "compare_to_source", {
      source: { assetId: "a1", name: "reference.mp4", duration: 71.6, type: "video", sound: "yes" },
      checked: [{ at: 1, source: 1 }],
    });
    expect(looks.size).toBe(0);
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
      "hears",
      "captionsSpeak",
      "closeness",
    ]);
  });
});
