import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { SETTINGS } from "@/lib/config/registry";
import { TOOL_AREA_NAMES } from "@/cut/server/ai/catalog";
import type { CutAgentDeps } from "./cutAgent";
import { EngineGate, engineInstant, handledSince, judgeEngineTurn } from "./engineTurn";

// A Claude or Codex turn judged from the page: the route it carries to the
// engine, the instant path that skips the engine, the asks the provider's
// session hears of later, and the quality gate the engine asks at sign-off.

const WATCH_RESULT = {
  images: [],
  sceneChanges: [1, 2, 3],
  coveredTo: 20,
  truncated: true,
  unwatchedSeconds: 51.6,
  recorded: [],
  unnoted: [{ from: 20, to: 71.6 }],
  source: { assetId: "a1", name: "reference.mp4", duration: 71.6 },
};

function routeAnswers(areas: string[]) {
  const out: Record<string, unknown> = {
    intent: {
      type: "choice",
      choice: "complex",
      probabilities: { chat: 0.02, simple: 0.08, complex: 0.9 },
      confidence: 0.9,
    },
    skill: { type: "choice", choice: "none", probabilities: { none: 0.9 }, confidence: 0.9 },
    needs_reference: { type: "noul", noul: 0.1 },
    unresolved_target: { type: "noul", noul: 0.02 },
  };
  for (const area of TOOL_AREA_NAMES) out[`area::${area}`] = { type: "noul", noul: areas.includes(area) ? 0.9 : 0.01 };
  return out;
}

function qualityAnswers(finished: number) {
  return {
    finished: { type: "noul", noul: finished },
    wantsChange: { type: "noul", noul: 0.9 },
    asksBack: { type: "noul", noul: 0.1 },
    seen: { type: "noul", noul: finished },
    honest: { type: "noul", noul: 0.9 },
    hears: { type: "noul", noul: 0.1 },
    captionsSpeak: { type: "noul", noul: 0.1 },
    next: { type: "choice", choice: "watch", probabilities: { watch: 0.8 }, confidence: 0.8 },
    closeness: { type: "choice", choice: "exact", probabilities: { exact: 0.8 }, confidence: 0.8 },
  };
}

function deps(opts: { finished?: number; delayMs?: number; settings?: Partial<CutAgentDeps["judgeSettings"]> } = {}) {
  const asks: string[][] = [];
  const d: CutAgentDeps = {
    post: async () => new Response(null, { status: 500 }),
    judge: async (payload) => {
      const questions = Object.keys((payload as { questions?: Record<string, unknown> }).questions ?? {});
      asks.push(questions);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const answers = questions.includes("finished") ? qualityAnswers(opts.finished ?? 0.9) : routeAnswers(["timeline"]);
      return new Response(JSON.stringify({ model: "jev-latest", answers, usage: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    judgeSettings: { ...SETTINGS.cutJudge.default, instantAction: false, judgeWaitMs: 500, ...opts.settings },
    execTool: async () => ({ ok: true }),
    models: { simple: "chatSimple", complex: "chat" },
    buildContext: () => ({ project: { aspect: "9:16" }, videoTrack: [], media: [] }),
    resolveRefs: async () => [],
  };
  return { deps: d, asks };
}

const user = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

describe("judgeEngineTurn", () => {
  test("a judged turn carries its areas, its skill pick and the gate", async () => {
    const { deps: d } = deps();
    const decision = await judgeEngineTurn([user("u1", "tighten every cut")], d);
    expect(decision?.route.intent).toBe("complex");
    expect(decision?.route.areas).toEqual(["timeline"]);
    expect(decision?.route.skill).toBeNull();
    expect(decision?.route.gate).toBe(true);
    expect(decision?.instant).toBeNull();
  });

  test("skill suggestion off leaves the skill out of the route", async () => {
    const { deps: d } = deps({ settings: { skillSuggestion: false } });
    const decision = await judgeEngineTurn([user("u1", "tighten every cut")], d);
    expect(decision ? "skill" in decision.route : true).toBe(false);
  });

  test("a judgment slower than the wait sends the turn unrouted", async () => {
    const { deps: d } = deps({ delayMs: 200, settings: { judgeWaitMs: 20 } });
    expect(await judgeEngineTurn([user("u1", "tighten every cut")], d)).toBeNull();
  });
});

describe("engineInstant", () => {
  test("the action runs in the editor and streams as a handled single-tool turn", async () => {
    const { deps: d } = deps();
    const ran: string[] = [];
    d.execTool = async (name) => {
      ran.push(name);
      return { id: "c1", muted: true };
    };
    const stream = await engineInstant({ id: "mute", tool: "set_clip_muted", args: { clipId: "c1", muted: true }, say: "Muted it." }, d);
    const chunks: Record<string, unknown>[] = [];
    const reader = stream!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as Record<string, unknown>);
    }
    expect(ran).toEqual(["set_clip_muted"]);
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "tool-input-available",
      "tool-output-available",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(chunks[0].messageMetadata).toEqual({
      handled: { tool: "set_clip_muted", args: { clipId: "c1", muted: true }, say: "Muted it." },
    });
  });

  test("a tool that throws leaves the turn to the engine", async () => {
    const { deps: d } = deps();
    d.execTool = async () => {
      throw new Error("no such clip");
    };
    expect(await engineInstant({ id: "mute", tool: "set_clip_muted", args: {}, say: "Muted it." }, d)).toBeNull();
  });
});

describe("handledSince", () => {
  test("the handled run before the newest message reaches the provider, oldest first", () => {
    const messages = [
      user("u1", "cut the intro"),
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Cut." }] } as UIMessage,
      user("u2", "mute it"),
      { id: "a2", role: "assistant", metadata: { handled: { tool: "set_clip_muted", args: { muted: true }, say: "Muted." } }, parts: [] } as UIMessage,
      user("u3", "make it 16:9"),
      { id: "a3", role: "assistant", metadata: { handled: { tool: "set_aspect", args: { aspect: "16:9" }, say: "Now 16:9." } }, parts: [] } as UIMessage,
      user("u4", "now add a title"),
    ];
    expect(handledSince(messages)).toEqual([
      { ask: "mute it", tool: "set_clip_muted", args: { muted: true }, say: "Muted." },
      { ask: "make it 16:9", tool: "set_aspect", args: { aspect: "16:9" }, say: "Now 16:9." },
    ]);
  });

  test("a provider turn last leaves nothing to report", () => {
    const messages = [
      user("u1", "cut the intro"),
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Cut." }] } as UIMessage,
      user("u2", "now add a title"),
    ];
    expect(handledSince(messages)).toEqual([]);
  });
});

describe("EngineGate", () => {
  test("a turn that half-watched its source is sent back once, then closes when nothing moved", async () => {
    const { deps: d, asks } = deps({ finished: 0.1 });
    const gate = new EngineGate("what happens in this video?");
    gate.record("watch_video", WATCH_RESULT, undefined);
    const steer = await gate.steer("It opens on a yellow title.", d);
    expect(steer).toContain("from=20");
    expect(await gate.steer("It opens on a yellow title.", d)).toBeNull();
    expect(asks.filter((q) => q.includes("finished")).length).toBe(1);
  });

  test("a turn that changed the project without looking is not held", async () => {
    const { deps: d, asks } = deps({ finished: 0.01 });
    const gate = new EngineGate("mute the first clip");
    gate.record("set_clip_muted", { id: "c1", muted: true }, undefined);
    expect(await gate.steer("Muted it.", d)).toBeNull();
    expect(asks.length).toBe(0);
  });

  test("the gate off lets the turn close", async () => {
    const { deps: d, asks } = deps({ finished: 0.1, settings: { qualityGate: false } });
    const gate = new EngineGate("what happens in this video?");
    gate.record("watch_video", WATCH_RESULT, undefined);
    expect(await gate.steer("It opens on a yellow title.", d)).toBeNull();
    expect(asks.length).toBe(0);
  });
});
