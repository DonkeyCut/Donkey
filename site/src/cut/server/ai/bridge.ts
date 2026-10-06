/**
 * Bridge between a running chat request and the browser.
 *
 * The chat route holds an open UI-message stream per session. When a
 * provider calls an MCP tool, the proxy POSTs here; we write the tool call
 * into the chat stream (the browser executes it against the editor store
 * and POSTs the result back), then hand the result to the provider.
 */

export interface UIChunkWriter {
  write: (chunk: Record<string, unknown>) => void;
}

interface Waiter {
  resolve: (r: { output?: unknown; errorText?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
  toolName: string;
  input: unknown;
}

interface Session {
  writer: UIChunkWriter;
  waiters: Map<string, Waiter>;
  /** Quality-gate asks the page has not answered yet, by gate id. */
  gates: Map<string, (steer: string | null) => void>;
  attached: boolean;
}

// Survives dev-server module reloads.
const g = globalThis as unknown as { __veditorAiSessions?: Map<string, Session> };
const sessions = (g.__veditorAiSessions ??= new Map<string, Session>());

// The project each chat session edits, kept past the stream's close: a tab
// that goes away mid-turn leaves the running provider's tool calls a route
// to the engine's own executor (headlessTools) for that project.
const g2 = globalThis as unknown as { __veditorAiProjects?: Map<string, string> };
const sessionProjects = (g2.__veditorAiProjects ??= new Map<string, string>());

export function registerSession(key: string, writer: UIChunkWriter, projectId?: string) {
  sessions.set(key, { writer, waiters: new Map(), gates: new Map(), attached: true });
  if (projectId) sessionProjects.set(key, projectId);
}

export function attachSession(key: string): void {
  const session = sessions.get(key);
  if (session) session.attached = true;
}

export function detachSession(key: string): void {
  const session = sessions.get(key);
  if (!session) return;
  session.attached = false;
  for (const waiter of session.waiters.values()) {
    clearTimeout(waiter.timer);
    const projectId = sessionProjects.get(key);
    if (!waiter.claimed && projectId)
      void detachedTool(projectId, waiter.toolName, waiter.input).then(waiter.resolve);
    else waiter.resolve({ errorText: "The editor disconnected before recording this result. Check the project state before repeating the operation." });
  }
  session.waiters.clear();
  settleGates(session);
}

export function unregisterSession(key: string) {
  const s = sessions.get(key);
  if (s) {
    for (const w of s.waiters.values()) {
      clearTimeout(w.timer);
      w.resolve({ errorText: "The chat request ended before the tool finished." });
    }
    settleGates(s);
  }
  sessions.delete(key);
  // The chat route unregisters after the provider run settles, so no more
  // tool calls can arrive under this key. Dropping the project mapping here
  // keeps the map bounded and keeps a reloaded tab's fresh session from ever
  // racing a leftover headless executor.
  sessionProjects.delete(key);
}

/** The chat stream carries a tool's output without its frames: the model
 * gets them through the returned result, the page never draws them, and one
 * watch_video's contact sheets would otherwise fill the turn journal. */
function streamedOutput(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return output;
  }
  const { image, images, ...rest } = output as Record<string, unknown>;
  if (image === undefined && images === undefined) {
    return output;
  }
  return { ...rest, imagesOmitted: true };
}

const TOOL_TIMEOUT_MS = 120_000; // subtitles generation can take a while

function detachedTool(projectId: string, toolName: string, input: unknown): Promise<{ output?: unknown; errorText?: string }> {
  return import("./headlessRuntime").then((module) => module.callDetachedTool(projectId, toolName, input)).catch((error: unknown) => ({
    errorText: error instanceof Error ? error.message : String(error),
  }));
}

/**
 * Forward a tool call to the browser via the chat stream and wait for the
 * result. Returns { output } or { errorText }.
 */
export function callBrowserTool(
  sessionKey: string,
  toolName: string,
  input: unknown
): Promise<{ output?: unknown; errorText?: string }> {
  const session = sessions.get(sessionKey);
  if (!session || !session.attached) {
    // The tab is gone (closed mid-turn) or the key is stale. A session whose
    // project is known finishes headless: the engine hydrates the doc and
    // runs the tool itself, so the turn completes and lands on disk.
    const projectId = sessionProjects.get(sessionKey);
    if (projectId) {
      console.log(`[cut-ai] ${toolName}: no editor tab for ${sessionKey}; running headless on ${projectId}`);
      const toolCallId = crypto.randomUUID();
      session?.writer.write({ type: "tool-input-available", toolCallId, toolName, input });
      return detachedTool(projectId, toolName, input).then((result) => {
        session?.writer.write(result.errorText !== undefined
          ? { type: "tool-output-error", toolCallId, errorText: result.errorText }
          : { type: "tool-output-available", toolCallId, output: streamedOutput(result.output ?? null) });
        return result;
      });
    }
    console.warn(
      `[cut-ai] ${toolName}: no live editor session for ${sessionKey}; live: ${[...sessions.keys()].join(", ") || "none"}`
    );
    return Promise.resolve({ errorText: "No live editor session for this chat." });
  }
  const toolCallId = crypto.randomUUID().slice(0, 12);
  session.writer.write({ type: "tool-input-available", toolCallId, toolName, input });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.waiters.delete(toolCallId);
      const errorText = `The editor did not answer the ${toolName} call in time.`;
      console.warn(`[cut-ai] ${toolName}: editor tab did not answer within ${TOOL_TIMEOUT_MS}ms (session ${sessionKey})`);
      session.writer.write({ type: "tool-output-error", toolCallId, errorText });
      resolve({ errorText });
    }, TOOL_TIMEOUT_MS);
    session.waiters.set(toolCallId, {
      timer,
      claimed: false,
      toolName,
      input,
      resolve: (r) => {
        if (r.errorText !== undefined) {
          session.writer.write({ type: "tool-output-error", toolCallId, errorText: r.errorText });
        } else {
          session.writer.write({ type: "tool-output-available", toolCallId, output: streamedOutput(r.output ?? null) });
        }
        resolve(r);
      },
    });
  });
}

export function claimBrowserTool(sessionKey: string, toolCallId: string): boolean {
  const waiter = sessions.get(sessionKey)?.waiters.get(toolCallId);
  if (!waiter || waiter.claimed) return false;
  waiter.claimed = true;
  return true;
}

/** Called by /api/cut/ai/tool-result when the browser finishes a tool. */
export function resolveBrowserTool(
  sessionKey: string,
  toolCallId: string,
  result: { output?: unknown; errorText?: string }
): boolean {
  const session = sessions.get(sessionKey);
  const waiter = session?.waiters.get(toolCallId);
  if (!session || !waiter) return false;
  session.waiters.delete(toolCallId);
  clearTimeout(waiter.timer);
  waiter.resolve(result);
  return true;
}

// The page judges the gate with the hosted judge; a page that does not
// answer in this long lets the turn close.
const GATE_TIMEOUT_MS = 20_000;

/** A gate no page will answer lets its turn close. */
function settleGates(session: Session) {
  for (const settle of session.gates.values()) settle(null);
  session.gates.clear();
}

/**
 * Ask the attached page whether a signing-off turn holds up. The page reads
 * the turn's record against the ask through the hosted judge and answers
 * with the steer for the next pass, or null to let the turn close. A session
 * with no attached page closes at once.
 */
export function askPageGate(sessionKey: string, reply: string): Promise<string | null> {
  const session = sessions.get(sessionKey);
  if (!session?.attached) return Promise.resolve(null);
  const gateId = crypto.randomUUID().slice(0, 12);
  session.writer.write({ type: "data-gate", data: { gateId, reply }, transient: true });
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(null), GATE_TIMEOUT_MS);
    const settle = (steer: string | null) => {
      clearTimeout(timer);
      session.gates.delete(gateId);
      resolve(steer);
    };
    session.gates.set(gateId, settle);
  });
}

/** Called by /api/cut/ai/gate with the page's verdict. */
export function resolvePageGate(sessionKey: string, gateId: string, steer: string | null): boolean {
  const settle = sessions.get(sessionKey)?.gates.get(gateId);
  if (!settle) return false;
  settle(steer);
  return true;
}
