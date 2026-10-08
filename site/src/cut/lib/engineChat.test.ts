import { afterEach, expect, spyOn, test } from "bun:test";
import type { UIMessage } from "ai";
import { localBackend } from "@/cut/lib/backend/local";
import { joinRunningEngineChat } from "@/cut/lib/engineChat";

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
