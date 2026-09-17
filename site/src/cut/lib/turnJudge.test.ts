import { describe, expect, test } from "bun:test";
import { SETTINGS } from "@/lib/config/registry";
import { AI_SKILL_INDEX, TOOL_AREA_NAMES } from "@/cut/server/ai/catalog";
import { judgeTurnState, pickSkill, routeTurn, TURN_JUDGE_QUESTIONS, type TurnJudgeAnswers } from "./turnJudge";

const settings = SETTINGS.cutJudge.default;

function answers(over: {
  intent?: { chat: number; simple: number; complex: number };
  skill?: string;
  gate?: number;
  unresolved?: number;
  fits?: Record<string, number>;
  areas?: Record<string, number>;
}): TurnJudgeAnswers {
  const p = over.intent ?? { chat: 0.05, simple: 0.8, complex: 0.15 };
  const winner = (Object.entries(p).sort((a, b) => b[1] - a[1])[0][0]) as "chat" | "simple" | "complex";
  const out: Record<string, unknown> = {
    intent: { type: "choice", choice: winner, probabilities: p, confidence: 0.8 },
    skill: {
      type: "choice",
      choice: over.skill ?? "none",
      probabilities: Object.fromEntries(["none", ...AI_SKILL_INDEX].map((n) => [n, n === (over.skill ?? "none") ? 0.7 : 0.01])),
      confidence: 0.7,
    },
    needs_reference: { type: "noul", noul: over.gate ?? 0.8 },
    unresolved_target: { type: "noul", noul: over.unresolved ?? 0.05 },
  };
  for (const name of AI_SKILL_INDEX) out[`fits::${name}`] = { type: "noul", noul: over.fits?.[name] ?? 0.05 };
  for (const area of TOOL_AREA_NAMES) out[`area::${area}`] = { type: "noul", noul: over.areas?.[area] ?? 0.05 };
  return out as unknown as TurnJudgeAnswers;
}

describe("TURN_JUDGE_QUESTIONS", () => {
  test("asks intent, skill, the gate, one fit per skill and one per area", () => {
    const keys = Object.keys(TURN_JUDGE_QUESTIONS);
    expect(keys.length).toBe(4 + AI_SKILL_INDEX.length + TOOL_AREA_NAMES.length);
    expect(Object.keys(TURN_JUDGE_QUESTIONS.skill.criteria)).toEqual(["none", ...AI_SKILL_INDEX]);
  });
});

describe("routeTurn", () => {
  test("a clear chat verdict withholds every tool and carries no skill", () => {
    const r = routeTurn(answers({ intent: { chat: 0.9, simple: 0.05, complex: 0.05 }, skill: "graphics", fits: { graphics: 0.9 } }), settings);
    expect(r.intent).toBe("chat");
    expect(r.skill).toBeNull();
  });

  test("simple needs a clear simple and little complex", () => {
    expect(routeTurn(answers({ intent: { chat: 0.1, simple: 0.6, complex: 0.3 } }), settings).intent).toBe("simple");
    expect(routeTurn(answers({ intent: { chat: 0.1, simple: 0.5, complex: 0.4 } }), settings).intent).toBe("complex");
    expect(routeTurn(answers({ intent: { chat: 0.5, simple: 0.45, complex: 0.05 } }), settings).intent).toBe("simple");
    expect(routeTurn(answers({ intent: { chat: 0.4, simple: 0.3, complex: 0.3 } }), settings).intent).toBe("complex");
  });

  const complex = { chat: 0.05, simple: 0.15, complex: 0.8 };

  test("an edit at an unnamed target takes the full model", () => {
    expect(routeTurn(answers({ unresolved: 0.8 }), settings).intent).toBe("complex");
  });

  test("a composed job carries the winning skill when the gate and its fit clear the floors", () => {
    const r = routeTurn(answers({ intent: complex, skill: "color-grading", fits: { "color-grading": 0.8 }, areas: { color: 0.9 } }), settings);
    expect(r.skill).toBe("color-grading");
    for (const a of ["color", "inspector"]) expect(r.areas).toContain(a);
  });

  test("a simple turn runs on the tool descriptions alone", () => {
    const a = answers({ skill: "color-grading", fits: { "color-grading": 0.9 }, areas: { color: 0.9 } });
    expect(pickSkill(a, settings)).toBe("color-grading");
    expect(routeTurn(a, settings).skill).toBeNull();
  });

  test("no skill when the ask needs nothing looked up", () => {
    expect(pickSkill(answers({ skill: "timeline-editing", fits: { "timeline-editing": 0.9 }, gate: 0.2 }), settings)).toBeNull();
    expect(pickSkill(answers({ skill: "none", fits: { graphics: 0.9 } }), settings)).toBeNull();
    expect(pickSkill(answers({ skill: "graphics", fits: { graphics: 0.1 } }), settings)).toBeNull();
  });

  test("areas are the ones above the threshold plus the skill's own", () => {
    const r = routeTurn(answers({ intent: complex, skill: "audio-and-subtitles", fits: { "audio-and-subtitles": 0.9 }, areas: { stock: 0.5, timeline: 0.2 } }), settings);
    for (const a of ["stock", "audio", "subtitles", "inspector", "timeline"]) expect(r.areas).toContain(a);
    expect(r.areas).not.toContain("scene");
    // Catalog order, so the declared list is stable.
    expect(r.areas).toEqual(TOOL_AREA_NAMES.filter((a) => r.areas.includes(a)));
  });

  test("a failed judgment fails open: the full model, every area, no skill", () => {
    const r = routeTurn(null, settings);
    expect(r).toEqual({ intent: "complex", skill: null, areas: [...TOOL_AREA_NAMES] });
  });

  test("routing off declares every area; suggestion off attaches nothing", () => {
    const off = { ...settings, toolRouting: false, skillSuggestion: false };
    const r = routeTurn(answers({ skill: "graphics", fits: { graphics: 0.9 }, areas: { color: 0.9 } }), off);
    expect(r.areas).toEqual([...TOOL_AREA_NAMES]);
    expect(r.skill).toBeNull();
  });
});

describe("judgeTurnState", () => {
  test("carries the newest ask, the turns before it, attachment metadata without urls, and an editor slice", () => {
    const state = judgeTurnState(
      [
        { id: "1", role: "user", parts: [{ type: "text", text: "add captions" }] },
        { id: "2", role: "assistant", parts: [{ type: "text", text: "Done." }] },
        {
          id: "3",
          role: "user",
          parts: [{ type: "text", text: "make them bigger" }],
          metadata: { attachments: [{ kind: "image", scope: "file", name: "ref.png", url: "data:..." }] },
        },
      ],
      { project: { aspect: "9:16", duration: 12 }, videoTrack: [{}, {}], overlays: [{ kind: "title" }], subtitles: { tracks: [{}] }, selection: { kind: "clip" } },
    ) as Record<string, unknown>;
    expect(state.request).toBe("make them bigger");
    expect(state.recent).toEqual([
      { role: "user", text: "add captions" },
      { role: "assistant", text: "Done." },
    ]);
    expect(state.attachments).toEqual([{ kind: "image", scope: "file", name: "ref.png" }]);
    expect(state.editor).toMatchObject({ aspect: "9:16", clips: 2, overlayKinds: ["title"], captionTracks: 1, selection: { kind: "clip" } });
    expect(JSON.stringify(state)).not.toContain("data:");
  });
});
