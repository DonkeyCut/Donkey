import { spawn, execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";

import {
  callBrowserTool,
  registerSession,
  resolveBrowserTool,
  unregisterSession,
  type UIChunkWriter,
} from "../ai/bridge";
import { rewriteCaptions, translateCaptions } from "../ai/captions";
import { writeVisualCues, type VisualFrame } from "../ai/visualSubtitles";
import { AI_SKILL_INDEX, AI_SKILLS, AI_TOOLS, attachedAssetsBlock, systemPrompt } from "../ai/catalog";
import { currentCutUser } from "../userScope";

interface ChatBody {
  messages: UIMessage[];
  model: string;
  context?: unknown;
  /** Provider-native session/thread id from the previous turn, if any. */
  providerSession?: string;
}

// Cut lives under site/src/cut; the proxy is spawned by filesystem path (not
// imported/bundled), so it is resolved from the dev cwd (site/) to its source.
const proxyPath = () =>
  path.join(process.cwd(), "src", "cut", "server", "ai", "mcp-proxy.mjs");

/** How to spawn the MCP proxy. The engine binary spawns itself with its
 * mcp-proxy subcommand; the dev server spawns node on the proxy source. The
 * account id rides along so the proxy's own engine calls carry the `u` scope
 * every data route requires — without it tools/list 400s and the model, left
 * with no editor tools, narrates tool calls as raw XML instead. */
function mcpCommand(base: string, sessionKey: string, user: string): { command: string; args: string[] } {
  return process.env.DONKEY_CUT_ENGINE
    ? { command: process.execPath, args: ["mcp-proxy", base, sessionKey, user] }
    : { command: process.execPath, args: [proxyPath(), base, sessionKey, user] };
}

function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    return m.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim();
  }
  return "";
}

/** Asset refs the user dragged into the chat with the last message. */
function lastUserAttachments(messages: UIMessage[]): unknown[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const meta = (m as { metadata?: { attachments?: unknown } }).metadata;
    return Array.isArray(meta?.attachments) ? meta.attachments : [];
  }
  return [];
}

/** Claude models through the Agent SDK — the user's Claude Code login. */
async function runClaude(
  emit: UIChunkWriter["write"],
  prompt: string,
  body: ChatBody,
  base: string,
  sessionKey: string,
  user: string,
  signal: AbortSignal
) {
  const q = query({
    prompt,
    options: {
      model: body.model,
      ...(body.providerSession ? { resume: body.providerSession } : {}),
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
          ...mcpCommand(base, sessionKey, user),
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
      maxTurns: 30,
      cwd: os.tmpdir(),
    },
  });
  const onAbort = () => void q.interrupt().catch(() => {});
  signal.addEventListener("abort", onAbort);

  let textCount = 0;
  let textId: string | null = null;
  try {
    for await (const msg of q) {
      const m = msg as unknown as Record<string, unknown> & { type: string };
      if (m.type === "system" && m.subtype === "init") {
        // The editor MCP is the assistant's entire tool surface. If it didn't
        // bind (an engine hiccup, an out-of-scope proxy call), the model would
        // improvise by narrating tool calls as raw XML — surface a clear error
        // instead of letting that reach the user.
        const tools = Array.isArray(m.tools) ? (m.tools as unknown[]) : [];
        if (!tools.some((t) => typeof t === "string" && t.startsWith("mcp__cut"))) {
          emit({ type: "error", errorText: "The editor tools didn't load. Reload the tab and try again." });
          await q.interrupt().catch(() => {});
          break;
        }
        emit({ type: "data-session", data: { providerSession: m.session_id }, transient: true });
      } else if (m.type === "stream_event") {
        const ev = m.event as {
          type: string;
          content_block?: { type: string };
          delta?: { type: string; text?: string };
        };
        if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
          textId = `t${++textCount}`;
          emit({ type: "text-start", id: textId });
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && textId) {
          emit({ type: "text-delta", id: textId, delta: ev.delta.text ?? "" });
        } else if (ev.type === "content_block_stop" && textId) {
          emit({ type: "text-end", id: textId });
          textId = null;
        }
      } else if (m.type === "result") {
        if (m.subtype !== "success") {
          const detail = typeof m.result === "string" ? m.result : String(m.subtype);
          emit({ type: "error", errorText: `Claude stopped: ${detail}` });
        }
        // The result message is the turn's last word — after it the CLI only
        // tears down. Leaving the loop closes the chat stream now instead of
        // holding the working indicator open through process exit.
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (textId) emit({ type: "text-end", id: textId });
  }
}

/** GPT models through the Codex CLI — the user's ChatGPT login. */
async function runCodex(
  emit: UIChunkWriter["write"],
  prompt: string,
  body: ChatBody,
  base: string,
  sessionKey: string,
  user: string,
  signal: AbortSignal
) {
  const mcp = mcpCommand(base, sessionKey, user);
  const session = body.providerSession;
  const args = ["exec"];
  if (session) args.push("resume", session);
  args.push("--json", "--skip-git-repo-check", "-m", body.model);
  // `codex exec resume` inherits the original session's sandbox and working
  // root, and its subcommand parser rejects --sandbox/-C. Pass those only on a
  // fresh run; appending them to a resume exits the CLI with code 2.
  if (!session) args.push("--sandbox", "read-only", "-C", os.tmpdir());
  args.push(
    "-c",
    `mcp_servers.cut.command=${JSON.stringify(mcp.command)}`,
    "-c",
    `mcp_servers.cut.args=${JSON.stringify(mcp.args)}`,
    session ? prompt : `${systemPrompt()}\n\n${prompt}`
  );

  await new Promise<void>((resolve, reject) => {
    // stdin must be closed: `codex exec` otherwise waits on it for EOF.
    const proc = spawn("codex", args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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
          emit({ type: "data-session", data: { providerSession: ev.thread_id }, transient: true });
        } else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) {
          const id = `t${++textCount}`;
          emit({ type: "text-start", id });
          emit({ type: "text-delta", id, delta: ev.item.text });
          emit({ type: "text-end", id });
        } else if (ev.type === "error" || ev.type === "turn.failed") {
          const message = ev.error?.message ?? ev.message ?? "Codex failed.";
          emit({ type: "error", errorText: message });
          if (ev.type === "turn.failed") settle();
        } else if (ev.type === "turn.completed") {
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
        err.message.includes("ENOENT")
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
        emit({ type: "error", errorText: `Codex exited with code ${code}. ${detail}`.trim() });
      }
      resolve();
    });
  });
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
  if (state.selection?.kind === "text") {
    const r = await callBrowserTool(sessionKey, "update_title", {
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
        const missing = err.message.includes("ENOENT");
        const note = missing
          ? `${cmd} is not installed`
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
        { error: e instanceof Error ? e.message : "Could not write captions." },
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
        { error: e instanceof Error ? e.message : "Could not caption the visuals." },
        { status: 500 }
      );
    }
  },

  async chat(req: Request) {
    const body = (await req.json()) as ChatBody;
    const base = new URL(req.url).origin;
    const user = currentCutUser();
    const sessionKey = crypto.randomUUID();
    const userText = lastUserText(body.messages);
    const attachments = lastUserAttachments(body.messages);
    const prompt = `${userText}${attachedAssetsBlock(attachments)}\n\n<editor_state>\n${JSON.stringify(body.context ?? {})}\n</editor_state>`;

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const emit: UIChunkWriter["write"] = (chunk) =>
          writer.write(chunk as Parameters<typeof writer.write>[0]);
        registerSession(sessionKey, { write: emit });
        emit({ type: "start" });
        // The browser posts tool outputs back to /api/cut/ai/tool-result with this key.
        emit({ type: "data-session", data: { sessionKey }, transient: true });
        try {
          if (body.model.startsWith("claude")) {
            await runClaude(emit, prompt, body, base, sessionKey, user, req.signal);
          } else if (body.model === "cut-test") {
            await runFake(emit, sessionKey, userText);
          } else {
            await runCodex(emit, prompt, body, base, sessionKey, user, req.signal);
          }
        } catch (err) {
          emit({ type: "error", errorText: err instanceof Error ? err.message : String(err) });
        } finally {
          unregisterSession(sessionKey);
          emit({ type: "finish" });
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  },

  async models() {
    let value = aiProbe && Date.now() - aiProbe.at < 60_000 ? aiProbe.value : null;
    if (!value) {
      const [claude, codexLogin] = await Promise.all([
        probe("claude", ["--version"]),
        probe("codex", ["login", "status"]),
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

  /** MCP-shaped tool catalog for the stdio proxy. */
  async proxyCatalog(req: Request) {
    const type = new URL(req.url).searchParams.get("type");
    if (type !== "catalog") return Response.json({ error: "Bad request." }, { status: 400 });
    return Response.json({
      tools: AI_TOOLS.map((t) => ({
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
    const def = AI_TOOLS.find((t) => t.name === name);
    if (!name || !def) {
      return Response.json({ ...mcpText(`Unknown tool: ${name}`), isError: true });
    }

    if (def.server) {
      if (name === "list_skills") return Response.json(mcpText({ skills: AI_SKILL_INDEX }));
      if (name === "read_skill") {
        const doc = AI_SKILLS[String(args?.name ?? "")];
        return doc
          ? Response.json(mcpText(doc))
          : Response.json({
              ...mcpText(`No such skill. Available: ${AI_SKILL_INDEX.join(", ")}`),
              isError: true,
            });
      }
    }

    const result = await callBrowserTool(String(sessionKey ?? ""), name, args ?? {});
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
