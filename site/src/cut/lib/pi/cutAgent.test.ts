import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { SETTINGS } from "@/lib/config/registry";
import { TOOL_AREA_NAMES } from "@/cut/server/ai/catalog";
import { QUALITY_STEER_PREFIX } from "../turnQuality";
import { dropPiSession, readPiSession, streamCutChat, type CutAgentDeps } from "./cutAgent";

// The quality gate inside the loop, driven against a canned model: a round
// that asks for no tools is the turn signing off, and the gate is what
// decides whether it may. Both judgments come through the one judge
// transport, told apart by the questions they ask.

/** One canned model round as the hosted route's SSE. */
function round(body: { text?: string; call?: { name: string; args: Record<string, unknown> } }) {
  const frame = {
    type: "response.completed",
    response: {
      ...(body.text ? { output_text: body.text } : {}),
      output: body.call
        ? [{ type: "function_call", id: `c-${body.call.name}`, name: body.call.name, arguments: body.call.args }]
        : [],
    },
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

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

function routeAnswers() {
  const out: Record<string, unknown> = {
    intent: {
      type: "choice",
      choice: "simple",
      probabilities: { chat: 0.02, simple: 0.9, complex: 0.08 },
      confidence: 0.9,
    },
    skill: { type: "choice", choice: "none", probabilities: { none: 0.9 }, confidence: 0.9 },
    needs_reference: { type: "noul", noul: 0.1 },
    unresolved_target: { type: "noul", noul: 0.02 },
  };
  for (const area of TOOL_AREA_NAMES) out[`area::${area}`] = { type: "noul", noul: 0.9 };
  return out;
}

function qualityAnswers(finished: number) {
  return {
    finished: { type: "noul", noul: finished },
    seen: { type: "noul", noul: finished },
    honest: { type: "noul", noul: 0.9 },
    next: { type: "choice", choice: "watch", probabilities: { watch: 0.8 }, confidence: 0.8 },
    closeness: { type: "choice", choice: "exact", probabilities: { exact: 0.8 }, confidence: 0.8 },
  };
}

async function drain(stream: ReadableStream<unknown>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value as Record<string, unknown>);
  }
  return out;
}

function harness(opts: { gateVerdicts: number[] }) {
  const modelPayloads: Record<string, unknown>[] = [];
  const judgeAsks: string[][] = [];
  let gateCalls = 0;
  const rounds: (() => Response)[] = [
    () => round({ call: { name: "watch_video", args: { asset_id: "a1", from: 0 } } }),
    () => round({ text: "That video opens on a yellow title and runs 71 seconds." }),
    () => round({ text: "Watched the rest of it." }),
    () => round({ text: "Still here." }),
  ];
  let roundIndex = 0;
  const deps: CutAgentDeps = {
    post: async (payload) => {
      modelPayloads.push(payload);
      const next = rounds[Math.min(roundIndex++, rounds.length - 1)];
      return next();
    },
    judge: async (payload) => {
      const questions = Object.keys(
        (payload as { questions?: Record<string, unknown> }).questions ?? {}
      );
      judgeAsks.push(questions);
      const answers = questions.includes("finished")
        ? qualityAnswers(opts.gateVerdicts[Math.min(gateCalls++, opts.gateVerdicts.length - 1)])
        : routeAnswers();
      return new Response(JSON.stringify({ model: "jev-latest", answers, usage: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    judgeSettings: { ...SETTINGS.cutJudge.default, instantAction: false, judgeWaitMs: 2000 },
    execTool: async () => WATCH_RESULT,
    models: { simple: "chatSimple", complex: "chat" },
    buildContext: () => ({ project: { aspect: "9:16" }, videoTrack: [], media: [] }),
    resolveRefs: async () => [],
  };
  return { deps, modelPayloads, judgeAsks, roundsUsed: () => roundIndex };
}

const ask = (text: string): UIMessage[] => [
  { id: "u1", role: "user", parts: [{ type: "text", text }] } as UIMessage,
];

describe("the quality gate in the turn loop", () => {
  test("a turn that half-watched its source is sent back before it can close", async () => {
    const threadId = "gate-holds";
    dropPiSession(threadId);
    const h = harness({ gateVerdicts: [0.1, 0.9] });
    await drain(
      streamCutChat({ threadId, model: "chat", messages: ask("what happens in this video?"), deps: h.deps })
    );
    // Round 1 watched, round 2 tried to close and was held, round 3 closed.
    expect(h.roundsUsed()).toBe(3);
    // Judged once: the third round came back having watched nothing more, and
    // a turn that has stopped moving is not sent back again.
    expect(h.judgeAsks.filter((q) => q.includes("finished")).length).toBe(1);
    // The steer reached the model as its own turn, carrying the real numbers.
    const sent = JSON.stringify(h.modelPayloads[2]);
    expect(sent).toContain(QUALITY_STEER_PREFIX);
    expect(sent).toContain("from=20");
    expect(sent).toContain("reference.mp4");
    // Turn-local scaffolding never enters the stored session.
    const session = readPiSession(threadId) ?? [];
    const steers = session.filter(
      (m) => typeof (m as { content?: unknown }).content === "string" &&
        String((m as { content: string }).content).startsWith(QUALITY_STEER_PREFIX)
    );
    expect(steers.length).toBe(0);
    dropPiSession(threadId);
  });

  test("work that holds up closes on its first sign-off", async () => {
    const threadId = "gate-passes";
    dropPiSession(threadId);
    const h = harness({ gateVerdicts: [0.95] });
    await drain(
      streamCutChat({ threadId, model: "chat", messages: ask("what happens in this video?"), deps: h.deps })
    );
    expect(h.roundsUsed()).toBe(2);
    expect(h.judgeAsks.filter((q) => q.includes("finished")).length).toBe(1);
    dropPiSession(threadId);
  });

  test("a turn that never opened a source is not held", async () => {
    const threadId = "gate-no-looks";
    dropPiSession(threadId);
    const h = harness({ gateVerdicts: [0.01] });
    h.deps.execTool = async () => ({ id: "c1", muted: true });
    await drain(
      streamCutChat({ threadId, model: "chat", messages: ask("mute the first clip"), deps: h.deps })
    );
    expect(h.roundsUsed()).toBe(2);
    expect(h.judgeAsks.filter((q) => q.includes("finished")).length).toBe(0);
    dropPiSession(threadId);
  });

  test("the gate off lets the turn close whatever the work looks like", async () => {
    const threadId = "gate-off";
    dropPiSession(threadId);
    const h = harness({ gateVerdicts: [0.01] });
    h.deps.judgeSettings = { ...SETTINGS.cutJudge.default, instantAction: false, qualityGate: false };
    await drain(
      streamCutChat({ threadId, model: "chat", messages: ask("what happens in this video?"), deps: h.deps })
    );
    expect(h.roundsUsed()).toBe(2);
    expect(h.judgeAsks.filter((q) => q.includes("finished")).length).toBe(0);
    dropPiSession(threadId);
  });
});
