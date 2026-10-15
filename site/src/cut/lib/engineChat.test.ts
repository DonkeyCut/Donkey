import { afterEach, expect, spyOn, test } from "bun:test";
import type { UIMessage } from "ai";
import { localBackend } from "@/cut/lib/backend/local";
import { joinRunningEngineChat, peekEngineChat } from "@/cut/lib/engineChat";

let cleanup = () => {};
afterEach(() => cleanup());

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

function engine(folded: boolean) {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const spy = spyOn(localBackend, "fetch").mockImplementation(async (path, init) => {
    calls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined });
    if (path.endsWith("/fold")) return Response.json({ folded });
    return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  cleanup = () => spy.mockRestore();
  return calls;
}

test("a message refused for a turn still running folds into it and follows its journal", async () => {
  const calls = engine(true);
  const response = await joinRunningEngineChat("project", "thread", { messages: [user("a", "fix the tilt")], context: { at: 1 } });
  expect(response?.headers.get("Content-Type")).toBe("text/event-stream");
  expect(calls.map((c) => c.path)).toEqual(["/api/cut/ai/chat/thread/fold", "/api/cut/ai/chat/thread/stream?projectId=project"]);
  expect(calls[0].body).toEqual({ projectId: "project", text: "fix the tilt", attachments: [], context: { at: 1 } });
});

test("a turn that ended before the fold leaves the message to go out as its own", async () => {
  const calls = engine(false);
  expect(await joinRunningEngineChat("project", "thread", { messages: [user("a", "fix the tilt")], context: {} })).toBeNull();
  expect(calls).toHaveLength(1);
});

test("a peek reads how far the thread's journal reaches", async () => {
  const paths: string[] = [];
  const spy = spyOn(localBackend, "fetch").mockImplementation(async (path) => {
    paths.push(path);
    return Response.json({ journal: { messageId: "turn-1", chunks: 900, running: false } });
  });
  cleanup = () => spy.mockRestore();
  expect(await peekEngineChat("project", "thread")).toEqual({ messageId: "turn-1", chunks: 900, running: false });
  expect(paths).toEqual(["/api/cut/ai/chat/thread/stream?projectId=project&peek=1"]);
});

test("a thread with no journal, or an engine that predates peeking, reads as none", async () => {
  let answer = () => Response.json({ journal: null });
  const spy = spyOn(localBackend, "fetch").mockImplementation(async () => answer());
  cleanup = () => spy.mockRestore();
  expect(await peekEngineChat("project", "thread")).toBeNull();
  let cancelled = false;
  answer = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/event-stream" } });
  expect(await peekEngineChat("project", "thread")).toBeNull();
  expect(cancelled).toBe(true);
});
