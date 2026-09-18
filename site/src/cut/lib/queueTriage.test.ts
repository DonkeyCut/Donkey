import { describe, expect, test } from "bun:test";
import { dueForRetriage, placeQueuedRows, queueTriageQuestions, queueTriageState, toolProgress, type QueueTriageAnswers } from "./queueTriage";

const rows = [
  { id: "m1", text: "also make the title blue" },
  { id: "m2", text: "then export it" },
];

const place = (choice: "fold" | "spawn" | "queue", p = 0.9) => ({
  type: "choice" as const,
  choice,
  probabilities: { fold: choice === "fold" ? p : (1 - p) / 2, spawn: choice === "spawn" ? p : (1 - p) / 2, queue: choice === "queue" ? p : (1 - p) / 2 },
  confidence: p,
});
const collides = (p: number) => ({ type: "noul" as const, noul: p });

describe("placeQueuedRows", () => {
  test("reads one verdict per row", () => {
    const out = placeQueuedRows(
      { "place::m1": place("fold"), "collides::m1": collides(0.1), "place::m2": place("queue"), "collides::m2": collides(0.1) } as QueueTriageAnswers,
      rows
    );
    expect(out.get("m1")).toBe("fold");
    expect(out.get("m2")).toBe("queue");
  });

  test("a collision forbids a spawn; a fold on colliding work stands", () => {
    const out = placeQueuedRows(
      { "place::m1": place("spawn"), "collides::m1": collides(0.8), "place::m2": place("fold"), "collides::m2": collides(0.8) } as QueueTriageAnswers,
      rows
    );
    expect(out.get("m1")).toBe("queue");
    expect(out.get("m2")).toBe("fold");
  });

  test("an uncertain placement queues", () => {
    const out = placeQueuedRows({ "place::m1": place("spawn", 0.3), "collides::m1": collides(0) } as QueueTriageAnswers, rows);
    expect(out.get("m1")).toBe("queue");
  });

  test("a row the answers skip, and a failed call, queue", () => {
    expect([...placeQueuedRows({ "place::m2": place("fold") } as QueueTriageAnswers, rows).values()]).toEqual(["queue", "fold"]);
    expect([...placeQueuedRows(null, rows).values()]).toEqual(["queue", "queue"]);
  });
});

describe("queueTriageQuestions", () => {
  test("asks a placement and a collision per row, keyed by the row's id", () => {
    const q = queueTriageQuestions(rows);
    expect(Object.keys(q)).toEqual(["place::m1", "collides::m1", "place::m2", "collides::m2"]);
    expect(q["place::m1"].type).toBe("choice");
    expect(q["collides::m2"].type).toBe("noul");
  });
});

describe("queueTriageState", () => {
  test("lays out the running ask, its progress, other chats, the waiting rows and the rows to place", () => {
    const state = queueTriageState(
      { ask: "cut the silences", progress: ["detect_silence", "split_clip (running)"], elsewhere: ["add captions"] },
      [{ id: "w1", text: "what's the total length?" }],
      rows
    ) as Record<string, unknown>;
    expect(state.running).toEqual({
      ask: "cut the silences",
      toolsRunSoFar: ["detect_silence", "split_clip (running)"],
      inOtherChats: ["add captions"],
    });
    expect(state.alreadyWaiting).toEqual(["what's the total length?"]);
    expect(state.messages).toEqual([
      { id: "m1", text: "also make the title blue" },
      { id: "m2", text: "then export it" },
    ]);
  });

  test("caps a pasted wall of text", () => {
    const state = queueTriageState({ ask: "x".repeat(5000), progress: [], elsewhere: [] }, [], [{ id: "m1", text: "y".repeat(5000) }]);
    expect(JSON.stringify(state).length).toBeLessThan(4400);
  });
});

describe("toolProgress", () => {
  test("names finished tools and marks open ones", () => {
    expect(
      toolProgress([
        { type: "text" },
        { type: "tool-detect_silence", state: "output-available" },
        { type: "dynamic-tool", toolName: "split_clip", state: "input-available" },
        { type: "tool-add_text", state: "output-error" },
      ])
    ).toEqual(["detect_silence", "split_clip (running)", "add_text"]);
  });
});

describe("dueForRetriage", () => {
  const base = { waiting: 1, cadenceMs: 4000, inFlight: false, lastAt: 0, now: 4000 };

  test("places the tray again once the cadence has passed", () => {
    expect(dueForRetriage(base)).toBe(true);
  });

  test("holds until the cadence has passed", () => {
    expect(dueForRetriage({ ...base, now: 3999 })).toBe(false);
  });

  test("never overlaps a call already out", () => {
    expect(dueForRetriage({ ...base, inFlight: true })).toBe(false);
  });

  test("does nothing with an empty tray", () => {
    expect(dueForRetriage({ ...base, waiting: 0 })).toBe(false);
  });

  test("a zero cadence places each row once, at send", () => {
    expect(dueForRetriage({ ...base, cadenceMs: 0, now: 1e9 })).toBe(false);
  });
});
