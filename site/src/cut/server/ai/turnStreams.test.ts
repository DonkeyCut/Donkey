import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UIMessageChunk } from "ai";
import { cancelTurnStream, followTurnStream, startTurnStream } from "./turnStreams";
import { callBrowserTool, claimBrowserTool, detachSession, registerSession, unregisterSession } from "./bridge";
import { createProject, readProject } from "../projects";

const root = await mkdtemp(path.join(os.tmpdir(), "donkey-chat-test-"));
const original = process.env.DONKEY_CUT_DATA_DIR;
process.env.DONKEY_CUT_DATA_DIR = root;
afterAll(async () => {
  if (original === undefined) delete process.env.DONKEY_CUT_DATA_DIR;
  else process.env.DONKEY_CUT_DATA_DIR = original;
  await rm(root, { recursive: true, force: true });
});

test("the engine completes with no readers and replays the finished journal", async () => {
  let output!: ReadableStreamDefaultController<UIMessageChunk>;
  let signal!: AbortSignal;
  let detached = 0;
  const response = await startTurnStream("project", "chat", (abort) => {
    signal = abort;
    return new ReadableStream({ start(controller) { output = controller; controller.enqueue({ type: "start", messageId: "reply" }); } });
  }, () => {}, () => { detached++; });
  await response.body!.cancel();
  expect(detached).toBe(1);
  expect(signal.aborted).toBe(false);
  output.enqueue({ type: "text-start", id: "text" });
  output.enqueue({ type: "text-delta", id: "text", delta: "Finished after closing the tab." });
  output.enqueue({ type: "text-end", id: "text" });
  output.enqueue({ type: "finish" });
  output.close();
  const replay = await followTurnStream("project", "chat");
  expect(await replay.text()).toContain("Finished after closing the tab.");
});

test("Stop cancels the run explicitly", async () => {
  let signal!: AbortSignal;
  const response = await startTurnStream("project", "stop", (abort) => {
    signal = abort;
    return new ReadableStream({ start(controller) { abort.addEventListener("abort", () => controller.close()); } });
  }, () => {}, () => {});
  cancelTurnStream("project", "stop");
  expect(signal.aborted).toBe(true);
  await response.text();
});

test("only one tab can claim a tool, and detached calls are not replayed", async () => {
  const chunks: Record<string, unknown>[] = [];
  registerSession("session", { write: (chunk) => chunks.push(chunk) });
  const pending = callBrowserTool("session", "get_state", {});
  const id = String(chunks[0].toolCallId);
  expect(claimBrowserTool("session", id)).toBe(true);
  expect(claimBrowserTool("session", id)).toBe(false);
  detachSession("session");
  expect((await pending).errorText).toContain("disconnected");
  expect(claimBrowserTool("session", id)).toBe(false);
  unregisterSession("session");
});

test("detached tools edit their original documents and journal their results", async () => {
  const first = await createProject("First chat test");
  const second = await createProject("Second chat test");
  const chunks: Record<string, unknown>[] = [];
  registerSession("first-project", { write: (chunk) => chunks.push(chunk) }, first.id);
  registerSession("second-project", { write: (chunk) => chunks.push(chunk) }, second.id);
  detachSession("first-project");
  detachSession("second-project");
  const results = await Promise.all([
    callBrowserTool("first-project", "set_project_name", { name: "First completed" }),
    callBrowserTool("second-project", "set_project_name", { name: "Second completed" }),
  ]);
  expect(results.every((result) => result.errorText === undefined)).toBe(true);
  expect((await readProject(first.id))?.name).toBe("First completed");
  expect((await readProject(second.id))?.name).toBe("Second completed");
  expect(chunks.filter((chunk) => chunk.type === "tool-output-available").length).toBe(2);
  unregisterSession("first-project");
  unregisterSession("second-project");
});

test("an unclaimed tool transfers to the engine when the tab disconnects", async () => {
  const project = await createProject("Unclaimed tool test");
  const chunks: Record<string, unknown>[] = [];
  registerSession("unclaimed", { write: (chunk) => chunks.push(chunk) }, project.id);
  const result = callBrowserTool("unclaimed", "set_project_name", { name: "Transferred" });
  const id = String(chunks[0].toolCallId);
  detachSession("unclaimed");
  expect(claimBrowserTool("unclaimed", id)).toBe(false);
  expect((await result).errorText).toBe(undefined);
  expect((await readProject(project.id))?.name).toBe("Transferred");
  expect(chunks.filter((chunk) => chunk.toolCallId === id).map((chunk) => chunk.type)).toEqual(["tool-input-available", "tool-output-available"]);
  unregisterSession("unclaimed");
});
