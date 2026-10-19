import { CHAT_RUNTIME } from "../../lib/chatRuntime";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { UIMessageChunk } from "ai";
import { cutDataRoot } from "../dataDir";
import { errorMessage } from "../util";

type Turn = { abort: AbortController; clients: number; finished: boolean; detached: () => void; attached: () => void };
const globalTurns = globalThis as unknown as { __cutChatTurns?: Map<string, Turn> };
const running = (globalTurns.__cutChatTurns ??= new Map<string, Turn>());
const keyFor = (projectId: string, threadId: string) => createHash("sha256").update(`${projectId}/${threadId}`).digest("hex");
const fileFor = (key: string) => path.join(cutDataRoot(), "chat-streams", `${key}.sse`);

// What each journal holds, kept as it is written so a peek never rereads it:
// the turn's message (null until a start chunk names one) and its chunks. A
// finished turn also leaves the count beside its journal, for a restarted
// engine; a journal with neither is counted once from its file.
type JournalCount = { messageId: string | null; chunks: number };
const globalJournals = globalThis as unknown as { __cutChatJournals?: Map<string, JournalCount> };
const journalCounts = () => (globalJournals.__cutChatJournals ??= new Map<string, JournalCount>());
const countFileFor = (key: string) => path.join(cutDataRoot(), "chat-streams", `${key}.json`);

/** The engine drains a turn into its journal independently of its viewers. */
export async function startTurnStream(
  projectId: string,
  threadId: string,
  source: (signal: AbortSignal) => ReadableStream<UIMessageChunk>,
  attached: () => void,
  detached: () => void,
  journalBytes = CHAT_RUNTIME.journalBytes,
  readerSignal?: AbortSignal,
): Promise<Response> {
  const key = keyFor(projectId, threadId);
  if (running.has(key)) return Response.json({ error: "This chat is already working." }, { status: 409 });
  const turn: Turn = { abort: new AbortController(), clients: 0, finished: false, attached, detached };
  running.set(key, turn);
  try {
    await mkdir(path.dirname(fileFor(key)), { recursive: true });
    // The previous turn's count goes first, so a crash mid-turn never pairs it with this journal.
    await rm(countFileFor(key), { force: true });
    const count: JournalCount = { messageId: null, chunks: 0 };
    journalCounts().set(key, count);
    const file = await open(fileFor(key), "w", 0o600);
    let reader: ReadableStreamDefaultReader<UIMessageChunk>;
    try { reader = source(turn.abort.signal).getReader(); }
    catch (error) { await file.close(); turn.abort.abort(); throw error; }
    void (async () => {
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const data = `data: ${JSON.stringify(value)}\n\n`;
          bytes += Buffer.byteLength(data);
          if (bytes > journalBytes) throw new Error("This chat turn exceeded its saved transcript limit.");
          await file.write(data);
          if (count.chunks === 0 && value.type === "start" && typeof value.messageId === "string") count.messageId = value.messageId;
          count.chunks++;
        }
      } catch (error) {
        turn.abort.abort();
        await file.write(`data: ${JSON.stringify({ type: "error", errorText: errorMessage(error, "Chat stopped.") })}\n\n`);
        count.chunks++;
      } finally {
        try { await file.write("data: [DONE]\n\n"); }
        finally {
          turn.finished = true;
          running.delete(key);
          reader.releaseLock();
          await file.close();
          await writeFile(countFileFor(key), JSON.stringify(count), { mode: 0o600 });
        }
      }
    })().catch((error) => console.error("[cut-ai] Could not finish the chat journal:", error));
    return followTurnStream(projectId, threadId, readerSignal);
  } catch (error) {
    running.delete(key);
    throw error;
  }
}

/** Each reader follows the same journal from its beginning; message ids merge on reconnect. */
export async function followTurnStream(projectId: string, threadId: string, signal?: AbortSignal): Promise<Response> {
  const key = keyFor(projectId, threadId);
  const fileName = fileFor(key);
  if (!(await stat(fileName).catch(() => null))) return new Response(null, { status: 204 });
  const file = await open(fileName, "r");
  const turn = running.get(key);
  if (turn) { turn.clients++; turn.attached(); }
  let closed = false;
  let position = 0;
  let lastWrite = Date.now();
  let output: ReadableStreamDefaultController<Uint8Array>;
  const disconnected = () => {
    void close().finally(() => { try { output.close(); } catch { /* The reader already closed. */ } }).catch(() => {});
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", disconnected);
    await file.close();
    if (turn && --turn.clients === 0 && !turn.finished) turn.detached();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      signal?.addEventListener("abort", disconnected, { once: true });
      if (signal?.aborted) disconnected();
    },
    async pull(controller) {
      try {
        while (!closed) {
          const buffer = Buffer.alloc(16 * 1024);
          const read = await file.read(buffer, 0, buffer.length, position);
          if (closed) return;
          if (read.bytesRead) {
            lastWrite = Date.now();
            position += read.bytesRead;
            controller.enqueue(buffer.subarray(0, read.bytesRead));
            return;
          }
          if (!turn || turn.finished) { await close(); controller.close(); return; }
          // A heartbeat also lets the HTTP adapter observe a vanished reader while a tool waits.
          if (Date.now() - lastWrite >= CHAT_RUNTIME.syncIntervalMs) {
            lastWrite = Date.now();
            controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        if (!closed) { await close(); controller.error(error); }
      }
    },
    cancel: close,
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "x-vercel-ai-ui-message-stream": "v1",
  } });
}

/** How much of a thread's newest turn its journal holds, without following
 * it: the turn's message, the chunks written so far, and whether it still
 * runs. A page compares the chunks with the ones its saved thread was built
 * from, and replays the journal when its copy fell behind. Null when the
 * thread has no journal. */
export async function peekTurnStream(projectId: string, threadId: string): Promise<{ messageId: string; chunks: number; running: boolean } | null> {
  const key = keyFor(projectId, threadId);
  const count = journalCounts().get(key) ?? await readJournalCount(key);
  if (!count?.messageId || count.chunks === 0) return null;
  return { messageId: count.messageId, chunks: count.chunks, running: running.has(key) };
}

/** A journal's count after a restart: the one its finished turn left, else
 * counted once from the journal itself (a turn the engine died during). */
async function readJournalCount(key: string): Promise<JournalCount | null> {
  const saved = await readFile(countFileFor(key), "utf8").then((text) => JSON.parse(text) as JournalCount).catch(() => null);
  const count = saved ?? await countJournal(key);
  if (count) journalCounts().set(key, count);
  return count;
}

async function countJournal(key: string): Promise<JournalCount | null> {
  const text = await readFile(fileFor(key), "utf8").catch(() => null);
  if (text === null) return null;
  const chunks = text.split("\n").filter((line) => line.startsWith("data: {"));
  let start: { type?: unknown; messageId?: unknown } = {};
  try { start = JSON.parse(chunks[0]?.slice("data: ".length) ?? "{}") as typeof start; } catch { /* A torn first line names no turn. */ }
  const messageId = start.type === "start" && typeof start.messageId === "string" ? start.messageId : null;
  return { messageId, chunks: chunks.length };
}

export function cancelTurnStream(projectId: string, threadId: string): void {
  running.get(keyFor(projectId, threadId))?.abort.abort();
}
