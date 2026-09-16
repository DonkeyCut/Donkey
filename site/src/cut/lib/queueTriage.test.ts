import { describe, expect, test } from "bun:test";
import { parseQueueTriage, queueTriageInput, toolProgress } from "./queueTriage";

const rows = [
  { id: "m1", text: "also make the title blue" },
  { id: "m2", text: "then export it" },
];

describe("parseQueueTriage", () => {
  test("reads one verdict per row", () => {
    const out = parseQueueTriage(
      JSON.stringify({ verdicts: [{ id: "m1", verdict: "fold" }, { id: "m2", verdict: "queue" }] }),
      rows
    );
    expect(out.get("m1")).toBe("fold");
    expect(out.get("m2")).toBe("queue");
  });

  test("a row the reply skips, misnames, or answers with another word stays queued", () => {
    const out = parseQueueTriage(
      JSON.stringify({ verdicts: [{ id: "m9", verdict: "spawn" }, { id: "m2", verdict: "later" }] }),
      rows
    );
    expect(out.get("m1")).toBe("queue");
    expect(out.get("m2")).toBe("queue");
  });

  test("a garbled or empty reply queues every row", () => {
    expect([...parseQueueTriage("fold", rows).values()]).toEqual(["queue", "queue"]);
    expect([...parseQueueTriage(undefined, rows).values()]).toEqual(["queue", "queue"]);
    expect([...parseQueueTriage("{}", rows).values()]).toEqual(["queue", "queue"]);
  });
});

describe("queueTriageInput", () => {
  test("lays out the running ask, its progress, other chats, the waiting rows and the rows to place", () => {
    const [turn] = queueTriageInput(
      { ask: "cut the silences", progress: ["detect_silence", "split_clip (running)"], elsewhere: ["add captions"] },
      [{ id: "w1", text: "what's the total length?" }],
      rows
    );
    const text = (turn.content as { text: string }[])[0].text;
    expect(text).toContain("Running ask:\ncut the silences");
    expect(text).toContain("Tools run so far: detect_silence, split_clip (running)");
    expect(text).toContain("Running in other chats:\n- add captions");
    expect(text).toContain("Already waiting in the queue:\n- what's the total length?");
    expect(text).toContain("[m1] also make the title blue\n[m2] then export it");
  });

  test("caps a pasted wall of text", () => {
    const [turn] = queueTriageInput(
      { ask: "x".repeat(5000), progress: [], elsewhere: [] },
      [],
      [{ id: "m1", text: "y".repeat(5000) }]
    );
    const text = (turn.content as { text: string }[])[0].text;
    expect(text.length).toBeLessThan(4400);
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
