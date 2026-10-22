import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { UIMessageChunk } from "ai";
import { cancelTurnStream, followTurnStream, peekTurnStream, startTurnStream } from "./turnStreams";
import { askPageGate, callBrowserTool, claimBrowserTool, detachSession, registerSession, resolveBrowserTool, resolvePageGate, unregisterSession } from "./bridge";
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

test("a peek reports how far the journal reaches while the turn runs and after", async () => {
  expect(await peekTurnStream("project", "never")).toBeNull();
  let output!: ReadableStreamDefaultController<UIMessageChunk>;
  const response = await startTurnStream("project", "peek", () => new ReadableStream({ start(controller) {
    output = controller;
    controller.enqueue({ type: "start", messageId: "turn-peek" });
    controller.enqueue({ type: "tool-input-available", toolCallId: "a", toolName: "add_title", input: {} });
  } }), () => {}, () => {});
  await response.body!.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await peekTurnStream("project", "peek")).toEqual({ messageId: "turn-peek", chunks: 2, running: true });
  output.enqueue({ type: "tool-output-available", toolCallId: "a", output: {} });
  output.enqueue({ type: "finish" });
  output.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await peekTurnStream("project", "peek")).toEqual({ messageId: "turn-peek", chunks: 4, running: false });
});

test("a peek reads the turn's count without rereading its journal, across an engine restart", async () => {
  const response = await startTurnStream("project", "peek-restart", () => new ReadableStream({ start(controller) {
    controller.enqueue({ type: "start", messageId: "turn-restart" });
    controller.enqueue({ type: "text-start", id: "t" });
    controller.enqueue({ type: "finish" });
    controller.close();
  } }), () => {}, () => {});
  await response.body!.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // An engine restart forgets what it held in memory.
  delete (globalThis as { __cutChatJournals?: unknown }).__cutChatJournals;
  // The journal is no longer read: garbage in its place leaves the count alone.
  const streams = path.join(root, "chat-streams");
  for (const name of await readdir(streams)) {
    if (!name.endsWith(".sse")) continue;
    const text = await readFile(path.join(streams, name), "utf8");
    if (text.includes("turn-restart")) await writeFile(path.join(streams, name), "not a journal");
  }
  expect(await peekTurnStream("project", "peek-restart")).toEqual({ messageId: "turn-restart", chunks: 3, running: false });
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
  expect(await claimBrowserTool("session", id)).toBe(true);
  expect(await claimBrowserTool("session", id)).toBe(false);
  detachSession("session");
  expect((await pending).errorText).toContain("disconnected");
  expect(await claimBrowserTool("session", id)).toBe(false);
  unregisterSession("session");
});

test("a turn's tools all run in the page that claimed its first one", async () => {
  // Two tabs follow the same turn; each edits its own copy of the project,
  // so a call landing in the other tab would miss what the first one made.
  const chunks: Record<string, unknown>[] = [];
  registerSession("pinned", { write: (chunk) => chunks.push(chunk) });
  void callBrowserTool("pinned", "import_url", {});
  const first = String(chunks[0].toolCallId);
  expect(await claimBrowserTool("pinned", first, "page-a")).toBe(true);
  expect(await claimBrowserTool("pinned", first, "page-b")).toBe(false);
  void callBrowserTool("pinned", "detect_silence", {});
  const next = String(chunks[1].toolCallId);
  // The other tab asks first; the call still waits for the tab that runs the turn.
  const other = claimBrowserTool("pinned", next, "page-b");
  expect(await claimBrowserTool("pinned", next, "page-a")).toBe(true);
  expect(await other).toBe(false);
  unregisterSession("pinned");
});

test("a turn's tools move to another tab when the claiming one stops answering", async () => {
  const chunks: Record<string, unknown>[] = [];
  registerSession("moved", { write: (chunk) => chunks.push(chunk) });
  void callBrowserTool("moved", "get_state", {});
  expect(await claimBrowserTool("moved", String(chunks[0].toolCallId), "page-a")).toBe(true);
  void callBrowserTool("moved", "get_state", {});
  void callBrowserTool("moved", "find_media", {});
  // page-a closed: page-b takes the call once it has waited, and the turn with it.
  expect(await claimBrowserTool("moved", String(chunks[1].toolCallId), "page-b")).toBe(true);
  expect(await claimBrowserTool("moved", String(chunks[2].toolCallId), "page-b")).toBe(true);
  unregisterSession("moved");
});

test("the page answers the quality gate, and a detached page lets the turn close", async () => {
  const chunks: Record<string, unknown>[] = [];
  registerSession("gate", { write: (chunk) => chunks.push(chunk) });
  const held = askPageGate("gate", "It opens on a title.");
  const ask = chunks[0] as { type: string; data: { gateId: string; reply: string }; transient: boolean };
  expect(ask.type).toBe("data-gate");
  expect(ask.transient).toBe(true);
  expect(ask.data.reply).toBe("It opens on a title.");
  expect(resolvePageGate("gate", ask.data.gateId, "Watch the rest.")).toBe(true);
  expect(await held).toBe("Watch the rest.");
  const pending = askPageGate("gate", "Done.");
  detachSession("gate");
  expect(await pending).toBeNull();
  expect(await askPageGate("gate", "Done.")).toBeNull();
  unregisterSession("gate");
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
  expect(await claimBrowserTool("unclaimed", id)).toBe(false);
  expect((await result).errorText).toBe(undefined);
  expect((await readProject(project.id))?.name).toBe("Transferred");
  expect(chunks.filter((chunk) => chunk.toolCallId === id).map((chunk) => chunk.type)).toEqual(["tool-input-available", "tool-output-available"]);
  unregisterSession("unclaimed");
});

test("frames reach the model and stay out of the turn journal", async () => {
  const chunks: Record<string, unknown>[] = [];
  registerSession("frames", { write: (chunk) => chunks.push(chunk) });
  const pending = callBrowserTool("frames", "watch_video", { assetId: "a" });
  const id = String(chunks[0].toolCallId);
  const frame = `data:image/jpeg;base64,${"A".repeat(2_000_000)}`;
  resolveBrowserTool("frames", id, { output: { duration: 10, image: frame, images: [frame, frame] } });
  const result = (await pending).output as { image?: string; images?: string[] };
  expect(result.image).toBe(frame);
  expect(result.images).toEqual([frame, frame]);
  const journaled = chunks.find((chunk) => chunk.type === "tool-output-available");
  expect(journaled?.output).toEqual({ duration: 10, imagesOmitted: true });
  expect(JSON.stringify(journaled).length).toBeLessThan(1000);
  unregisterSession("frames");
});

test("sound reaches the model and stays out of the turn journal", async () => {
  const chunks: Record<string, unknown>[] = [];
  registerSession("sound", { write: (chunk) => chunks.push(chunk) });
  const pending = callBrowserTool("sound", "listen_audio", { asset_id: "a" });
  const id = String(chunks[0].toolCallId);
  const audio = `data:audio/wav;base64,${"A".repeat(2_000_000)}`;
  resolveBrowserTool("sound", id, { output: { coveredTo: 30, audio } });
  expect(((await pending).output as { audio?: string }).audio).toBe(audio);
  const journaled = chunks.find((chunk) => chunk.type === "tool-output-available");
  expect(journaled?.output).toEqual({ coveredTo: 30, audioOmitted: true });
  unregisterSession("sound");
});
