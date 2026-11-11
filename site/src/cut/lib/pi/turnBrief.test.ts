import { describe, expect, test } from "bun:test";
import { CUT_JUDGE } from "../chatRuntime";
import { briefMeasures, briefSteer, type BriefItem } from "../turnBrief";
import type { CutAgentDeps } from "./cutAgent";
import { TurnGate } from "./turnGate";

// The brief hold: a turn handed a guide in a note, or a long pasted ask, is
// split into a checklist and held to every item before it signs off.

const GUIDE = "Add a title. There should always be graphics moving. Play the joins back.";

const ITEMS = [
  { what: "Add a title at the start", kind: "once" },
  { what: "Keep graphics moving at all times", kind: "throughout" },
  { what: "Play the joins back", kind: "verify" },
];

/** A cut like the one this hold was built for: 71s of talking head, one
 * title at the top and one still picture in the middle. */
const CONTEXT = {
  project: { duration: 71.12 },
  videoTrack: [{ asset: "IMG_1.mov", start: 0, len: 71.12 }],
  overlayVideo: [{ asset: "Claude Code terminal.png", start: 34.64, len: 2.67 }],
  overlays: [{ kind: "text", name: "Let's talk about ChatGPT Plugins", start: 0, end: 2.31 }],
  soundtrack: [{ asset: "Night Ride", start: 0, len: 71.12, in: 28, volume: 0.25 }],
  subtitles: { count: 0 },
  publish: { caption: "ChatGPT Plugins are here!", tags: "chatgpt plugins" },
  media: [
    { name: "IMG_1.mov", type: "video" },
    { name: "Claude Code terminal.png", type: "image" },
    { name: "Night Ride", type: "audio" },
    { name: "spare.mov", type: "video" },
  ],
};

function deps(done: Record<string, number>) {
  const splits: string[] = [];
  const judged: string[][] = [];
  const d: CutAgentDeps = {
    post: async (payload) => {
      const input = (payload as { input: { content: { text: string }[] }[] }).input;
      splits.push(input[0].content[0].text);
      return Response.json({ output_text: JSON.stringify({ items: ITEMS }) });
    },
    judge: async (payload) => {
      const questions = Object.keys((payload as { questions: Record<string, unknown> }).questions);
      judged.push(questions);
      const answers = Object.fromEntries(questions.map((q) => [q, { type: "noul", noul: done[q] ?? 0.9 }]));
      return Response.json({ model: "jev-latest", answers, usage: {} });
    },
    judgeSettings: CUT_JUDGE,
    execTool: async () => ({ ok: true }),
    models: { simple: "chatSimple", complex: "chat" },
    buildContext: () => CONTEXT,
    resolveRefs: async () => [],
  };
  return { deps: d, splits, judged };
}

describe("briefMeasures", () => {
  test("measures graphics coverage, motion and the longest bare stretch", () => {
    const m = briefMeasures(CONTEXT) as {
      graphics: { secondsCovered: number; secondsMoving: number; longestStretchWithout: unknown };
      publish: { characters: number };
      mediaOffTimeline: string[];
    };
    expect(m.graphics.secondsCovered).toBe(4.98);
    expect(m.graphics.secondsMoving).toBe(0);
    expect(m.graphics.longestStretchWithout).toEqual({ from: 37.31, to: 71.12 });
    expect(m.publish.characters).toBe(40);
    expect(m.mediaOffTimeline).toEqual(["spare.mov"]);
  });
});

describe("briefSteer", () => {
  test("names each open item and carries the coverage for a throughout item", () => {
    const open: BriefItem[] = [{ id: "item2", what: "Keep graphics moving at all times", kind: "throughout" }];
    const steer = briefSteer(open, briefMeasures(CONTEXT), "[quality]");
    expect(steer.startsWith("[quality] Not yet.")).toBe(true);
    expect(steer).toContain("1. (throughout) Keep graphics moving at all times");
    expect(steer).toContain("Graphics now cover 4.98s of the 71.12s cut, 0s of it moving");
    expect(steer).toContain("from 37.31s to 71.12s");
  });
});

describe("TurnGate brief hold", () => {
  test("a turn that read a guide is held to its open items, then closes when they are met", async () => {
    const { deps: d, splits, judged } = deps({ item2: 0.1, item3: 0.2 });
    const gate = new TurnGate("follow this guide", "simple");
    gate.record("read_note", { id: "n1", body: GUIDE }, undefined);
    gate.record("add_title", { id: "t1" }, undefined);

    // The split reads the ask and the note, and two items come back open.
    const first = await gate.hold("Done.", d, CUT_JUDGE);
    expect(splits[0]).toContain("follow this guide");
    expect(splits[0]).toContain(GUIDE);
    expect(first?.step).toBe("brief");
    expect(first?.steer).toContain("(throughout) Keep graphics moving at all times");
    expect(first?.steer).toContain("(verify) Play the joins back");
    expect(first?.steer).not.toContain("Add a title at the start");

    // More work, every item met: the turn closes, and the split is not asked again.
    const met = deps({});
    gate.record("set_overlay_animation", { id: "t1" }, undefined);
    expect(await gate.hold("Done.", { ...met.deps, post: d.post }, CUT_JUDGE)).toBeNull();
    expect(splits.length).toBe(1);
    expect(judged[0]).toEqual(["item1", "item2", "item3"]);
  });

  test("a simple ask with no note is not split", async () => {
    const { deps: d, splits } = deps({ item1: 0.1 });
    const gate = new TurnGate("mute the first clip", "simple");
    gate.record("set_clip_muted", { id: "c1" }, undefined);
    expect(await gate.hold("Muted it.", d, CUT_JUDGE)).toBeNull();
    expect(splits.length).toBe(0);
  });

  test("a complex pasted ask is split with no note beside it", async () => {
    const { deps: d, splits } = deps({ item2: 0.1 });
    const gate = new TurnGate(GUIDE, "complex");
    gate.record("add_title", { id: "t1" }, undefined);
    expect((await gate.hold("Done.", d, CUT_JUDGE))?.step).toBe("brief");
    expect(splits.length).toBe(1);
    expect(splits[0]).toContain(`The ask, as the person typed it:\n${GUIDE}`);
  });

  test("a turn that returns with nothing new closes", async () => {
    const { deps: d } = deps({ item2: 0.1 });
    const gate = new TurnGate(GUIDE, "complex");
    gate.record("add_title", { id: "t1" }, undefined);
    expect(await gate.hold("Done.", d, CUT_JUDGE)).not.toBeNull();
    expect(await gate.hold("Done.", d, CUT_JUDGE)).toBeNull();
  });

  test("open items stop holding after the brief rounds run out", async () => {
    const { deps: d } = deps({ item2: 0.1 });
    const gate = new TurnGate(GUIDE, "complex");
    for (let i = 0; i < CUT_JUDGE.qualityBriefRounds; i++) {
      gate.record("add_shape", { id: `s${i}` }, undefined);
      expect(await gate.hold("Done.", d, CUT_JUDGE)).not.toBeNull();
    }
    gate.record("add_shape", { id: "last" }, undefined);
    expect(await gate.hold("Done.", d, CUT_JUDGE)).toBeNull();
  });

  test("a note read twice joins the brief once", async () => {
    const { deps: d, splits } = deps({ item2: 0.1 });
    const gate = new TurnGate("follow this guide", "simple");
    gate.record("read_note", { id: "n1", title: "Editor", body: GUIDE }, undefined);
    gate.record("read_note", { id: "n1", title: "Editor", body: GUIDE }, undefined);
    gate.record("add_title", { id: "t1" }, undefined);
    await gate.hold("Done.", d, CUT_JUDGE);
    expect(splits[0].split(GUIDE).length - 1).toBe(1);
    expect(splits[0]).toContain('titled "Editor"');
  });

  test("the editor is read live at sign-off, and a chat whose project is closed is not held", async () => {
    const { deps: d, judged } = deps({ item2: 0.1 });
    const gate = new TurnGate(GUIDE, "complex");
    gate.record("add_title", { id: "t1" }, undefined);
    expect(await gate.hold("Done.", { ...d, editorNow: () => null }, CUT_JUDGE)).toBeNull();
    expect(judged.length).toBe(0);

    // A live read wins over the turn-start snapshot.
    gate.record("add_shape", { id: "s1" }, undefined);
    const live = { ...CONTEXT, overlays: [{ kind: "shape", name: "Bar", start: 0, end: 71.12, anim: { in: "pop" } }] };
    const verdict = await gate.hold("Done.", { ...d, editorNow: () => live }, CUT_JUDGE);
    expect(verdict?.steer).toContain("Graphics now cover 71.12s of the 71.12s cut");
  });

  test("a split that fails lets the turn close", async () => {
    const { deps: d } = deps({ item2: 0.1 });
    const gate = new TurnGate(GUIDE, "complex");
    gate.record("add_title", { id: "t1" }, undefined);
    const failing = { ...d, post: async () => new Response(null, { status: 500 }) };
    expect(await gate.hold("Done.", failing, CUT_JUDGE)).toBeNull();
  });
});
