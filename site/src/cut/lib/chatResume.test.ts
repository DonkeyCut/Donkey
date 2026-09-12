import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { DETACHED_MEDIA_ERROR, DETACHED_UI_NOTE, INTERRUPTED_ERROR, isResumeMessage, resumePrompt, scrubLostTurn, unfinishedAsk } from "./chatResume";

const user = (id: string, text: string, metadata?: Record<string, unknown>): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }], ...(metadata ? { metadata } : {}) }) as UIMessage;
const reply = (id: string, parts: UIMessage["parts"] = [{ type: "text", text: "Done." }]): UIMessage => ({ id, role: "assistant", parts });
const tool = (state: string, extra: Record<string, unknown>) =>
  ({ type: "tool-add_clip", toolCallId: "call", state, input: {}, ...extra }) as unknown as UIMessage["parts"][number];

test("an ask with no reply resumes", () => {
  expect(unfinishedAsk([user("ask", "cut the pauses")], undefined, undefined)?.id).toBe("ask");
});

test("a reply cut off before it completed resumes its ask", () => {
  const messages = [user("ask", "cut the pauses"), reply("partial", [tool("output-error", { errorText: "Interrupted." })])];
  expect(unfinishedAsk(messages, "earlier", undefined)?.id).toBe("ask");
});

test("a completed reply settles the thread", () => {
  expect(unfinishedAsk([user("ask", "cut the pauses"), reply("done")], "done", undefined)).toBeUndefined();
});

test("a stopped or failed turn waits for the user", () => {
  const messages = [user("ask", "cut the pauses"), reply("partial")];
  expect(unfinishedAsk(messages, undefined, "stopped")).toBeUndefined();
  expect(unfinishedAsk([user("ask", "cut the pauses")], undefined, "failed")).toBeUndefined();
});

test("a completed reply that ran with no tab attached resumes on return", () => {
  const detached = [user("ask", "make a thumbnail"), reply("done", [tool("output-error", { errorText: DETACHED_MEDIA_ERROR })])];
  expect(unfinishedAsk(detached, "done", undefined)?.id).toBe("ask");
  const noEffect = [user("ask", "open captions"), reply("done", [tool("output-available", { output: { noEditor: true, note: DETACHED_UI_NOTE } })])];
  expect(unfinishedAsk(noEffect, "done", undefined)?.id).toBe("ask");
  const ordinary = [user("ask", "add it"), reply("done", [tool("output-error", { errorText: "No clip with that id." })])];
  expect(unfinishedAsk(ordinary, "done", undefined)).toBeUndefined();
});

test("a continuation that itself got cut off resumes the original ask", () => {
  const messages = [user("ask", "cut the pauses"), reply("partial"), user("again", "continue", { resume: true })];
  expect(isResumeMessage(messages[2])).toBe(true);
  expect(unfinishedAsk(messages, undefined, undefined)?.id).toBe("ask");
});

test("the continuation quotes the ask", () => {
  expect(resumePrompt(user("ask", "cut the pauses"))).toContain('"""\ncut the pauses\n"""');
  expect(resumePrompt(user("ask", ""))).toContain("only attachments");
});

test("scrubbing a lost turn keeps only the tool calls that landed", () => {
  const landed = tool("output-available", { output: { ok: true } });
  const messages = [
    user("earlier", "first ask"),
    reply("old", [tool("output-error", { errorText: INTERRUPTED_ERROR })]),
    user("ask", "cut the pauses"),
    reply("partial", [{ type: "text", text: "Cutting" }, landed, tool("output-error", { errorText: INTERRUPTED_ERROR })]),
    reply("empty", [{ type: "text", text: "I could not, no page was attached." }, tool("output-error", { errorText: DETACHED_MEDIA_ERROR })]),
  ];
  const scrubbed = scrubLostTurn(messages, "ask");
  expect(scrubbed.map((m) => m.id)).toEqual(["earlier", "old", "ask", "partial"]);
  expect(scrubbed[3].parts).toEqual([landed]);
  expect(scrubLostTurn(messages, "missing")).toBe(messages);
});

test("the continuation asks for a reply that says nothing about the interruption", () => {
  expect(resumePrompt(user("ask", "cut the pauses"))).toContain("say nothing about the page going away");
});
