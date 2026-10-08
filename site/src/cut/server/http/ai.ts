import { spawn, execFile } from "node:child_process";
import os from "node:os";
import { z } from "zod";
import { SETTINGS } from "@/lib/config/registry";
import { startTurnStream, followTurnStream, cancelTurnStream } from "../ai/turnStreams";
import { foldIntoTurn, openFoldInbox, type Fold, type FoldInbox } from "../ai/turnFolds";
import path from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeFailure } from "../ai/claudeFailure";
import { createUIMessageStream, type UIMessage } from "ai";

import {
  callBrowserTool,
  attachSession,
  detachSession,
  claimBrowserTool,
  askPageGate,
  registerSession,
  resolvePageGate,
  resolveBrowserTool,
  unregisterSession,
  type UIChunkWriter,
} from "../ai/bridge";
import { rewriteCaptions, translateCaptions } from "../ai/captions";
import { writeVisualCues, type VisualFrame } from "../ai/visualSubtitles";
import { AI_SKILL_INDEX, AI_TOOLS, attachedAssetsBlock, readSkill, skillRelevanceBlock, systemPrompt } from "../ai/catalog";
import {
  declaresTool,
  declareTurn,
  dropTurn,
  handledSchema,
  routeSchema,
  takeWidened,
  turnTools,
  widenTurn,
  type EngineRoute,
  type HandledAsk,
} from "../ai/turnCatalog";
import { STEP_BUDGET, stopText, turnClose, type TurnEnd } from "../../lib/turnBudget";
import { pendingAsk } from "../../lib/chatResume";
import { codexCommand } from "../tool-path";
import { errorMessage } from "../util";

interface ChatBody {
  threadId: string;
  messages: UIMessage[];
  model: string;
  context?: unknown;
  /** Provider-native session/thread id from the previous turn, if any. */
  providerSession?: string;
  /** The page's judged route; absent when the turn was not judged. */
  route?: EngineRoute;
  /** Asks the editor carried out on its own since the provider's last turn. */
  handled?: HandledAsk[];
}

// The steer a Codex turn resumes on once request_tools widened its catalog.
const WIDENED_STEER = "The tool areas you requested are declared now. Carry on with the request.";

/** The asks the provider's session never saw, as prompt text. The editor ran
 * them straight from the judgment, so a resumed session learns of them here. */
function handledBlock(handled: HandledAsk[]): string {
  if (handled.length === 0) return "";
  const lines = handled.map((h) => `- "${h.ask}" → ${h.tool} ${JSON.stringify(h.args)}: ${h.say}`);
  return `<handled_by_editor>\nThe editor carried out these asks itself since your last turn:\n${lines.join("\n")}\n</handled_by_editor>\n\n`;
}

// Cut lives under site/src/cut; the proxy is spawned by filesystem path (not
// imported/bundled), so it is resolved from the dev cwd (site/) to its source.
const proxyPath = () =>
  path.join(process.cwd(), "src", "cut", "server", "ai", "mcp-proxy.mjs");

/** How to spawn the MCP proxy. The engine binary spawns itself with its
 * mcp-proxy subcommand; the dev server spawns node on the proxy source. */
function mcpCommand(base: string, sessionKey: string): { command: string; args: string[] } {
  return process.env.DONKEY_CUT_ENGINE
    ? { command: process.execPath, args: ["mcp-proxy", base, sessionKey] }
    : { command: process.execPath, args: [proxyPath(), base, sessionKey] };
}

/** Claude models through the Agent SDK — the user's Claude Code login. */
async function runClaude(
  emit: UIChunkWriter["write"],
  prompt: string,
  body: ChatBody,
  base: string,
  sessionKey: string,
  inbox: FoldInbox,
  signal: AbortSignal
) {
  signal.throwIfAborted();
  let textCount = 0;
  let session = body.providerSession;
  // The newest assistant message's text: the line the quality gate reads.
  let reply = "";
  const say = (text: string) => {
    const id = `t${++textCount}`;
    emit({ type: "text-start", id });
    emit({ type: "text-delta", id, delta: text });
    emit({ type: "text-end", id });
  };

  /** One run of the query. It ends when the model signs off, when the SDK
   * spends the step budget, or when the editor tools failed to bind.
   *
   * The input stays open for the run so folds reach the CLI as they land: it
   * injects each one at the model's next step and acknowledges it then, and
   * one that lands as the model signs off starts a follow-on reply in the same
   * session. The run ends on a result with no fold still unacknowledged. */
  const pass = async (ask: string): Promise<TurnEnd> => {
    signal.throwIfAborted();
    const unacked: Fold[] = [];
    const outbox: string[] = [];
    let wake = null as (() => void) | null;
    let open = true;
    const unlisten = inbox.listen((fold) => {
      unacked.push(fold);
      outbox.push(fold.text);
      wake?.();
    });
    const userMessage = (text: string): SDKUserMessage => ({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield userMessage(ask);
      for (;;) {
        while (outbox.length) yield userMessage(outbox.shift()!);
        if (!open) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    }
    // The CLI echoes each input message as it takes it; the first is the ask.
    let echoes = 0;
    const q = query({
      prompt: input(),
      options: {
        model: body.model,
        ...(session ? { resume: session } : {}),
        // Inside the compiled engine the SDK can't resolve its built-in CLI;
        // the engine resolves the user's own Claude Code install at startup.
        ...(process.env.DONKEY_CUT_CLAUDE
          ? { pathToClaudeCodeExecutable: process.env.DONKEY_CUT_CLAUDE }
          : {}),
        systemPrompt: systemPrompt(),
        tools: [], // no built-in tools — the editor MCP server is the whole surface
        mcpServers: {
          cut: {
            type: "stdio",
            ...mcpCommand(base, sessionKey),
            alwaysLoad: true,
          },
        },
        allowedTools: ["mcp__cut"],
        permissionMode: "dontAsk",
        settingSources: [], // don't drag the user's CLAUDE.md/settings into app chats
        // The editor MCP is the whole tool surface. settingSources:[] only drops
        // filesystem config — the SDK still auto-fetches the account's claude.ai
        // cloud connectors (Gmail, Drive, …) and surfaces them to the model.
        // These two flags make the isolation total: no connectors, and no MCP
        // server except the one we pass here.
        strictMcpConfig: true,
        settings: { disableClaudeAiConnectors: true },
        includePartialMessages: true,
        extraArgs: { "replay-user-messages": null },
        maxTurns: STEP_BUDGET,
        cwd: os.tmpdir(),
      },
    });
    const onAbort = () => void q.interrupt().catch(() => {});
    signal.addEventListener("abort", onAbort);

    let end: TurnEnd = "done";
    let textId: string | null = null;
    try {
      for await (const msg of q) {
        const m = msg as unknown as Record<string, unknown> & { type: string };
        const failure = claudeFailure(m);
        if (failure) {
          emit({ type: "error", errorText: failure });
          end = "failed";
          break;
        }
        if (m.type === "system" && m.subtype === "init") {
          // The editor MCP is the assistant's entire tool surface. If it didn't
          // bind (an engine hiccup, an out-of-scope proxy call), the model would
          // improvise by narrating tool calls as raw XML — surface a clear error
          // instead of letting that reach the user.
          const tools = Array.isArray(m.tools) ? (m.tools as unknown[]) : [];
          if (!tools.some((t) => typeof t === "string" && t.startsWith("mcp__cut"))) {
            emit({ type: "error", errorText: "The editor tools didn't load. Reload the tab and try again." });
            await q.interrupt().catch(() => {});
            end = "blocked";
            break;
          }
          // Each run gets its own session id; the next one resumes from the
          // newest, so an extended turn keeps one continuous history.
          if (typeof m.session_id === "string") session = m.session_id;
          emit({ type: "data-session", data: { providerSession: m.session_id }, transient: true });
        } else if (m.type === "user" && m.isReplay === true) {
          if (echoes++ > 0) unacked.shift()?.resolve(true);
        } else if (m.type === "stream_event") {
          const ev = m.event as {
            type: string;
            content_block?: { type: string };
            delta?: { type: string; text?: string };
          };
          if (ev.type === "message_start") {
            reply = "";
          } else if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
            textId = `t${++textCount}`;
            emit({ type: "text-start", id: textId });
          } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && textId) {
            reply += ev.delta.text ?? "";
            emit({ type: "text-delta", id: textId, delta: ev.delta.text ?? "" });
          } else if (ev.type === "content_block_stop" && textId) {
            emit({ type: "text-end", id: textId });
            textId = null;
          }
        } else if (m.type === "result") {
          // The SDK names its stops with tokens ("error_max_turns"), which
          // say nothing to someone waiting on a half-built edit: a spent
          // budget carries on below, and anything else is said in words.
          if (m.subtype === "error_max_turns") end = "budget";
          else if (m.subtype !== "success") {
            end = "failed";
            emit({ type: "error", errorText: stopText(m.result) });
          }
          // A fold the CLI holds runs next, in this same session.
          if (unacked.length) continue;
          // The result message is the run's last word — after it the CLI only
          // tears down. Leaving the loop closes the chat stream now instead of
          // holding the working indicator open through process exit.
          break;
        }
      }
    } finally {
      unlisten();
      open = false;
      wake?.();
      for (const fold of unacked.splice(0)) fold.resolve(false);
      signal.removeEventListener("abort", onAbort);
      if (textId) emit({ type: "text-end", id: textId });
    }
    return end;
  };

  // A run that spent the budget resumes from its own session, so the next
  // one carries the whole tool history and the build finishes on its own.
  // A judged turn that signs off asks the page's quality gate first, and a
  // hold resumes the session on the gate's steer.
  let ask = prompt;
  let extensions = 0;
  for (;;) {
    const end = await pass(ask);
    if (signal.aborted) return;
    const steer = end === "done" && body.route?.gate ? await askPageGate(sessionKey, reply) : null;
    if (steer && !signal.aborted) {
      ask = steer;
      continue;
    }
    const close = turnClose({ end, spoke: textCount > 0, extensions });
    if (!close) return;
    if ("signoff" in close) return say(close.signoff);
    ask = close.steer;
    extensions++;
  }
}

/** GPT models through the Codex CLI — the user's ChatGPT login. */
async function runCodex(
  emit: UIChunkWriter["write"],
  prompt: string,
  body: ChatBody,
  base: string,
  sessionKey: string,
  inbox: FoldInbox,
  signal: AbortSignal
) {
  // `codex exec` reads no input once it starts, so a fold waits for the run
  // to finish and goes in as a resumed run of the same session, inside this
  // turn.
  let session = body.providerSession;
  let ask = prompt;
  for (;;) {
    const run = await codexRun(emit, ask, body.model, session, base, sessionKey, signal);
    session = run.thread ?? session;
    if (signal.aborted || !session) return;
    const folds = inbox.take();
    if (folds.length) {
      for (const fold of folds) fold.resolve(true);
      ask = folds.map((fold) => fold.text).join("\n\n");
      continue;
    }
    // Codex lists its tools once per run, so a widened catalog takes a run.
    if (takeWidened(sessionKey)) {
      ask = WIDENED_STEER;
      continue;
    }
    // A failed run already showed its error and the page stopped reading:
    // only a run that completed asks the gate, as on the Claude path.
    const steer = run.end === "done" && body.route?.gate ? await askPageGate(sessionKey, run.reply) : null;
    if (!steer || signal.aborted) return;
    ask = steer;
  }
}

/** One `codex exec` run; returns the session it ran in, its last line, and
 * how it ended. */
async function codexRun(
  emit: UIChunkWriter["write"],
  prompt: string,
  model: string,
  session: string | undefined,
  base: string,
  sessionKey: string,
  signal: AbortSignal
): Promise<{ thread: string | undefined; reply: string; end: TurnEnd }> {
  signal.throwIfAborted();
  const codex = await codexCommand();
  const mcp = mcpCommand(base, sessionKey);
  let thread = session;
  let reply = "";
  let end: TurnEnd = "done";
  const args = ["exec"];
  if (session) args.push("resume", session);
  args.push("--json", "--skip-git-repo-check", "-m", model);
  // `codex exec resume` inherits the original session's sandbox and working
  // root, and its subcommand parser rejects --sandbox/-C. Pass those only on a
  // fresh run; appending them to a resume exits the CLI with code 2.
  if (!session) args.push("--sandbox", "read-only", "-C", os.tmpdir());
  args.push(
    "-c",
    `mcp_servers.cut.command=${JSON.stringify(mcp.command)}`,
    "-c",
    `mcp_servers.cut.args=${JSON.stringify(mcp.args)}`,
    // Codex asks before an MCP tool runs by default, and `exec` can never ask:
    // the call fails with "requires approval, but approval policy is never".
    // The editor tools are the whole point of the run, so approve them all.
    "-c",
    `mcp_servers.cut.default_tools_approval_mode="approve"`,
    session ? prompt : `${systemPrompt()}\n\n${prompt}`
  );

  await new Promise<void>((resolve, reject) => {
    // stdin must be closed: `codex exec` otherwise waits on it for EOF.
    const proc = spawn(codex, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const onAbort = () => proc.kill("SIGTERM");
    signal.addEventListener("abort", onAbort);

    // The turn settles on its terminal event, not on process exit: codex
    // spends seconds saving the session after turn.completed, and holding the
    // stream open that long keeps the chat's working indicator running past
    // the finished reply. The process keeps writing its session in the
    // background; once settled, late process events must not touch the
    // (closed) stream writer.
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    let textCount = 0;
    // Part ids stay unique across the runs a turn makes.
    const run = crypto.randomUUID().slice(0, 8);
    const say = (text: string) => {
      const id = `${run}-t${++textCount}`;
      emit({ type: "text-start", id });
      emit({ type: "text-delta", id, delta: text });
      emit({ type: "text-end", id });
    };
    let stdoutBuf = "";
    let stderrTail = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let ev: { type?: string; thread_id?: string; message?: string; item?: { type?: string; text?: string }; error?: { message?: string } };
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "thread.started" && ev.thread_id) {
          thread = ev.thread_id;
          emit({ type: "data-session", data: { providerSession: ev.thread_id }, transient: true });
        } else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) {
          reply = ev.item.text;
          say(ev.item.text);
        } else if (ev.type === "error" || ev.type === "turn.failed") {
          end = "failed";
          emit({ type: "error", errorText: stopText(ev.error?.message ?? ev.message) });
          if (ev.type === "turn.failed") settle();
        } else if (ev.type === "turn.completed") {
          // The CLI runs a turn to its own end — there is no step cap to
          // extend — so the only ending it can leave open is a silent one.
          const close = turnClose({ end: "done", spoke: textCount > 0, extensions: 0 });
          if (close && "signoff" in close && !signal.aborted) say(close.signoff);
          settle();
        }
        if (settled) return;
      }
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error("Codex CLI not found — install it with: npm i -g @openai/codex")
          : err
      );
    });
    proc.on("close", (code) => {
      if (settled) return;
      signal.removeEventListener("abort", onAbort);
      if (code !== 0 && !signal.aborted && code !== null) {
        const lines = stderrTail.trim().split("\n").map((l) => l.trim()).filter(Boolean);
        // clap puts the real diagnostic on the first `error:` line; the tail is
        // just Usage/`try '--help'` boilerplate. Surface the error line if present.
        const detail = lines.find((l) => /^error[:\s]/i.test(l)) ?? lines.slice(-2).join(" ");
        end = "failed";
        emit({ type: "error", errorText: `Codex exited with code ${code}. ${detail}`.trim() });
      }
      resolve();
    });
  });
  return { thread, reply, end };
}

/**
 * Hermetic provider for tests: exercises the exact same bridge path
 * (context → tool round-trips through the browser → streamed reply)
 * without spending any tokens.
 */
async function runFake(emit: UIChunkWriter["write"], sessionKey: string, userText: string) {
  const say = (id: string, text: string) => {
    emit({ type: "text-start", id });
    emit({ type: "text-delta", id, delta: text });
    emit({ type: "text-end", id });
  };
  emit({ type: "data-session", data: { providerSession: "test-thread" }, transient: true });
  if (/first frame/i.test(userText)) {
    const r = await callBrowserTool(sessionKey, "freeze_frame", { duration: 1 });
    say("t1", r.errorText ? `Tool failed: ${r.errorText}` : "Done: FREEZEMARK frame pinned to the start.");
    return;
  }
  say("t1", "Let me check what's selected.");
  const st = await callBrowserTool(sessionKey, "get_state", {});
  if (st.errorText !== undefined) {
    emit({ type: "error", errorText: st.errorText });
    return;
  }
  const state = st.output as {
    selection?: { kind: string; id: string } | null;
  };
  if (state.selection?.kind === "overlay") {
    const r = await callBrowserTool(sessionKey, "update_overlay", {
      id: state.selection.id,
      text: "TESTMARK improved",
      color: "#FFD60A",
    });
    say("t2", r.errorText ? `Tool failed: ${r.errorText}` : "Done: TESTMARK applied to your title.");
  } else {
    const r = await callBrowserTool(sessionKey, "add_title", { text: "TESTMARK title" });
    say("t2", r.errorText ? `Tool failed: ${r.errorText}` : "Done: TESTMARK title added.");
  }
}

function probe(cmd: string, args: string[]): Promise<{ ok: boolean; note: string; installed: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        // ENOENT means the binary isn't on PATH; any other error means it ran
        // (installed) but exited non-zero. The page hides an uninstalled
        // provider while still showing a sign-in prompt for an installed one.
        // Check err.code, not the message: Bun (the shipped engine runtime)
        // words the error `Executable not found in $PATH` with no "ENOENT".
        const missing = err.code === "ENOENT";
        const note = missing
          ? `${path.basename(cmd)} is not installed`
          : (stderr || err.message).trim().split("\n")[0];
        resolve({ ok: false, note, installed: !missing });
      } else {
        // Some CLIs (codex) report status on stderr.
        resolve({ ok: true, note: (stdout.trim() || stderr.trim()).split("\n")[0], installed: true });
      }
    });
  });
}

// Providers rarely change mid-session; cache probes for a minute.
type ProviderStatus = { ok: boolean; note: string; installed: boolean };
let aiProbe: {
  at: number;
  value: { claude: ProviderStatus; codex: ProviderStatus };
} | null = null;

const mcpText = (value: unknown) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

/** The AI assistant: chat streaming, provider probing, and the MCP bridge. */
export const aiApi = {
  /** Rewrite subtitle cues into punchy social captions, or — when translateTo
   * carries a locale — translate them into that language. One-to-one either
   * way, timings preserved. The style rewrite falls back to the originals on
   * failure; a failed translation errors instead. */
  async captions(req: Request) {
    try {
      const { cues, style, translateTo } = (await req.json()) as {
        cues?: { start: number; end: number; text: string }[];
        style?: string;
        translateTo?: string;
      };
      if (!Array.isArray(cues) || cues.length === 0) {
        return Response.json({ error: "No cues to rewrite." }, { status: 400 });
      }
      const texts =
        typeof translateTo === "string" && translateTo
          ? await translateCaptions(cues, translateTo)
          : await rewriteCaptions(cues, typeof style === "string" ? style : "clean");
      return Response.json({ texts });
    } catch (e) {
      return Response.json(
        { error: errorMessage(e, "Could not write captions.") },
        { status: 500 }
      );
    }
  },

  /** Write subtitle cues from sampled frames — for cuts with no usable audio.
   * Runs through the user's own Claude login, like the captions rewrite. */
  async visualSubtitles(req: Request) {
    try {
      const { frames, duration, locale } = (await req.json()) as {
        frames?: VisualFrame[];
        duration?: number;
        locale?: string;
      };
      if (!Array.isArray(frames) || frames.length === 0 || typeof duration !== "number") {
        return Response.json({ error: "frames and duration are required." }, { status: 400 });
      }
      const cues = await writeVisualCues(frames, duration, typeof locale === "string" ? locale : undefined);
      return Response.json({ cues });
    } catch (e) {
      return Response.json(
        { error: errorMessage(e, "Could not caption the visuals.") },
        { status: 500 }
      );
    }
  },

  async chat(req: Request) {
    const body = (await req.json().catch(() => null)) as ChatBody;
    const identity = z.object({
      threadId: z.string().min(1).max(200),
      model: z.string().min(1).max(200),
      messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant", "system"]), parts: z.array(z.object({ type: z.string() })) })),
      runtime: SETTINGS.chatRuntime.schema,
      context: z.object({ project: z.object({ id: z.string().min(1).max(200) }) }),
      route: routeSchema.optional(),
      handled: handledSchema.optional(),
    }).safeParse(body);
    if (!identity.success) return Response.json({ error: "A project and chat are required." }, { status: 400 });
    const projectId = identity.data.context.project.id;
    const { route, handled = [] } = identity.data;
    const base = new URL(req.url).origin;
    const sessionKey = crypto.randomUUID();
    const { text: userText, attachments } = pendingAsk(body.messages);
    // A judged work turn carries the judge's skill pick, the same block the
    // hosted loop attaches.
    const skill = route && route.intent !== "chat" && route.skill !== undefined ? `\n\n${skillRelevanceBlock(route.skill)}` : "";
    const prompt = `${handledBlock(handled)}${userText}${attachedAssetsBlock(attachments)}${skill}\n\n<editor_state>\n${JSON.stringify(body.context ?? {})}\n</editor_state>`;
    declareTurn(sessionKey, route, body.model.startsWith("claude") ? "live" : "next-run");

    return startTurnStream(projectId, body.threadId, (signal) => createUIMessageStream({
      execute: async ({ writer }) => {
        const emit: UIChunkWriter["write"] = (chunk) =>
          writer.write(chunk as Parameters<typeof writer.write>[0]);
        // The editor snapshot names the project; the bridge keeps it so a
        // turn whose tab closes finishes through the engine's own executor.
        const projectId = (body.context as { project?: { id?: string } } | undefined)?.project?.id;
        registerSession(sessionKey, { write: emit }, typeof projectId === "string" ? projectId : undefined);
        emit({ type: "start", messageId: `turn-${sessionKey}`, messageMetadata: {
          requestMessageId: body.messages.findLast((message) => message.role === "user")?.id,
        } });
        // The browser posts tool outputs back to /api/cut/ai/tool-result with this key.
        emit({ type: "data-session", data: { sessionKey }, transient: true });
        const folds = openFoldInbox(identity.data.context.project.id, body.threadId);
        try {
          if (body.model.startsWith("claude")) {
            await runClaude(emit, prompt, body, base, sessionKey, folds.inbox, signal);
          } else if (body.model === "cut-test") {
            await runFake(emit, sessionKey, userText);
          } else {
            await runCodex(emit, prompt, body, base, sessionKey, folds.inbox, signal);
          }
        } catch (err) {
          emit({ type: "error", errorText: errorMessage(err, String(err)) });
        } finally {
          folds.close();
          unregisterSession(sessionKey);
          dropTurn(sessionKey);
          emit({ type: "finish" });
        }
      },
    }), () => attachSession(sessionKey), () => detachSession(sessionKey), identity.data.runtime.journalBytes, req.signal);
  },

  async resumeChat(req: Request, threadId: string) {
    const projectId = new URL(req.url).searchParams.get("projectId");
    if (!projectId) return Response.json({ error: "A project is required." }, { status: 400 });
    return followTurnStream(projectId, threadId, req.signal);
  },

  /** A message sent while the thread's turn runs, folded into that turn.
   * Answers once the provider has taken it, or false when the turn ended
   * first. */
  async foldChat(req: Request, threadId: string) {
    const body = z.object({
      projectId: z.string().min(1).max(200),
      text: z.string().min(1).max(100_000),
      attachments: z.array(z.unknown()).max(100).default([]),
      context: z.unknown(),
    }).safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: "A project and a message are required." }, { status: 400 });
    const { projectId, text, attachments, context } = body.data;
    const prompt = `${text}${attachedAssetsBlock(attachments)}\n\n<editor_state>\n${JSON.stringify(context ?? {})}\n</editor_state>`;
    return Response.json({ folded: await foldIntoTurn(projectId, threadId, prompt) });
  },

  async cancelChat(req: Request, threadId: string) {
    const body = z.object({ projectId: z.string().min(1).max(200) }).safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: "A project is required." }, { status: 400 });
    cancelTurnStream(body.data.projectId, threadId);
    return Response.json({ ok: true });
  },

  async claimTool(req: Request) {
    const body = z.object({ sessionKey: z.string().min(1).max(200), toolCallId: z.string().min(1).max(200) }).safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: "A chat session and tool call are required." }, { status: 400 });
    return Response.json({ claimed: claimBrowserTool(body.data.sessionKey, body.data.toolCallId) });
  },

  async models() {
    let value = aiProbe && Date.now() - aiProbe.at < 60_000 ? aiProbe.value : null;
    if (!value) {
      const [claude, codexLogin] = await Promise.all([
        probe("claude", ["--version"]),
        probe(await codexCommand(), ["login", "status"]),
      ]);
      // The login probe running at all means codex is installed; only its
      // ENOENT failure (carried through in codexLogin) marks it missing.
      const codex: ProviderStatus = codexLogin.ok
        ? /logged in/i.test(codexLogin.note)
          ? { ok: true, note: codexLogin.note, installed: true }
          : { ok: false, note: "Not signed in — run: codex login", installed: true }
        : codexLogin;
      value = { claude, codex };
      aiProbe = { at: Date.now(), value };
    }
    // The model catalog lives in the page (src/cut/lib/aiModels.ts); the
    // engine only reports which provider CLIs are usable on this Mac.
    return Response.json({
      providers: {
        claude: { available: value.claude.ok, note: value.claude.note, installed: value.claude.installed },
        codex: { available: value.codex.ok, note: value.codex.note, installed: value.codex.installed },
        // Gemini chats run from the page through Donkey's hosted inference;
        // the browser overlays the real availability from its sign-in probe.
        gemini: { available: true, note: "runs on your Donkey account", installed: true },
        test: { available: true, note: "hermetic test provider", installed: true },
      },
    });
  },

  /** MCP-shaped tool catalog for the stdio proxy: the session's turn
   * catalog. */
  async proxyCatalog(req: Request) {
    const params = new URL(req.url).searchParams;
    if (params.get("type") !== "catalog") return Response.json({ error: "Bad request." }, { status: 400 });
    return Response.json({
      tools: turnTools(params.get("session")).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  },

  /** Execute one tool call: server-side skills directly, editor tools via the browser. */
  async proxyCall(req: Request) {
    const { sessionKey, name, args } = (await req.json()) as {
      sessionKey?: string;
      name?: string;
      args?: Record<string, unknown>;
    };
    const key = String(sessionKey ?? "");
    if (name === "request_tools") return Response.json(mcpText(widenTurn(key, args?.areas)));
    const def = AI_TOOLS.find((t) => t.name === name);
    if (!name || !def) {
      return Response.json({ ...mcpText(`Unknown tool: ${name}`), isError: true });
    }
    if (!declaresTool(key, name)) {
      return Response.json({ ...mcpText(`${name} is not declared this turn. Call request_tools with its area first.`), isError: true });
    }

    if (def.server) {
      if (name === "list_skills") return Response.json(mcpText({ skills: AI_SKILL_INDEX }));
      if (name === "read_skill") {
        const doc = readSkill(String(args?.name ?? ""));
        return doc
          ? Response.json(mcpText(doc))
          : Response.json({
              ...mcpText(`No such skill. Available: ${AI_SKILL_INDEX.join(", ")}`),
              isError: true,
            });
      }
    }

    const result = await callBrowserTool(key, name, args ?? {});
    if (result.errorText !== undefined) {
      return Response.json({ ...mcpText(result.errorText), isError: true });
    }
    // Frames come back as data URLs in `image`/`images`; hand them to the
    // model as MCP image blocks. The data text rides first, so a provider
    // that can't read images still gets the numbers.
    const out = result.output as { image?: unknown; images?: unknown } | undefined;
    const urls = [
      ...(typeof out?.image === "string" ? [out.image] : []),
      ...(Array.isArray(out?.images)
        ? out.images.filter((u): u is string => typeof u === "string")
        : []),
    ]
      .filter((u) => u.startsWith("data:image/"))
      .slice(0, 6);
    if (urls.length > 0) {
      const rest = Object.fromEntries(
        Object.entries(out as Record<string, unknown>).filter(([k]) => k !== "image" && k !== "images")
      );
      return Response.json({
        content: [
          { type: "text", text: JSON.stringify(rest) },
          ...urls.map((u) => {
            const [head, data] = u.split(",", 2);
            return { type: "image", data, mimeType: head.slice(5, head.indexOf(";")) };
          }),
        ],
      });
    }
    return Response.json(mcpText(result.output ?? { ok: true }));
  },

  /** The page's quality-gate verdict for a signing-off turn. */
  async gate(req: Request) {
    const body = z.object({
      sessionKey: z.string().min(1).max(200),
      gateId: z.string().min(1).max(200),
      steer: z.string().max(20_000).nullable(),
    }).safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: "A chat session and gate are required." }, { status: 400 });
    return Response.json({ ok: resolvePageGate(body.data.sessionKey, body.data.gateId, body.data.steer) });
  },

  /** The browser posts tool outputs here after executing them on the store. */
  async toolResult(req: Request) {
    const { sessionKey, toolCallId, output, errorText } = (await req.json()) as {
      sessionKey?: string;
      toolCallId?: string;
      output?: unknown;
      errorText?: string;
    };
    if (!sessionKey || !toolCallId) {
      return Response.json({ error: "sessionKey and toolCallId required." }, { status: 400 });
    }
    const ok = resolveBrowserTool(sessionKey, toolCallId, { output, errorText });
    return Response.json({ ok });
  },
};
