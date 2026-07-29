"use client";

import type { UIMessage, UIMessageChunk } from "ai";
import { geminiModelRoles } from "@/lib/inference/gemini-models";
import { AI_SKILL_INDEX, AI_SKILLS, AI_TOOLS, attachedAssetsBlock, systemPrompt, toolsRanBlock } from "@/cut/server/ai/catalog";
import { buildAiContext } from "./aiContext";
import { runAiTool } from "./aiTools";
import { normalizeRef } from "./assetRef";
import { NO_CREDITS_MESSAGE, useGenerate } from "./generate";
import { hostedPost } from "./hosted";
import { refsToParts } from "./refMedia";
import { parseTurnIntent, TURN_INTENT_PROMPT, turnIntentInput, type TurnIntent } from "./turnIntent";

// Gemini chat runs from the page through Donkey's hosted Responses route with
// the user's sign-in and credits — the local engine is not involved (same
// carve-out as AI media generation). Each round the model answers or asks for
// editor tools; tools execute right here against the live store via runAiTool,
// and their results go back until the model settles on a reply. The whole
// conversation is replayed per turn, so no provider session is kept.

const MAX_TOOL_ROUNDS = 24;

// A round request gets a couple more tries when the failure is transient —
// rate limits and upstream hiccups — before the turn surfaces an error. Auth
// (401), credits (402), and validation failures surface immediately.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_RETRIES = 2;
// Gemini can return an empty STOP round — no text, no tool calls (same class
// as the empty-TTS behavior). Identical re-asks usually land, so the loop
// retries before bothering the user.
const EMPTY_ROUND_RETRIES = 2;

const backoff = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 600 * (attempt + 1)));

/** One round-trip to the hosted Responses route, retrying transient failures.
 * With onDelta the route streams the round: text deltas arrive as the model
 * writes them, and the returned body is the same shape a plain round returns.
 * A broken stream retries only while no delta has been delivered — replaying
 * a partly-shown round would duplicate its text. */
async function postRound(
  payload: Record<string, unknown>,
  abortSignal?: AbortSignal,
  onDelta?: (delta: string) => void
): Promise<ResponseBody> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await hostedPost(
        "/api/inference/responses",
        onDelta ? { ...payload, stream: true } : payload,
        abortSignal
      );
    } catch (err) {
      // Network drop — retry unless the user stopped the turn or we're out.
      if (abortSignal?.aborted || attempt >= TRANSIENT_RETRIES) throw err;
      await backoff(attempt);
      continue;
    }
    if (res.ok) {
      if (!onDelta) return (await res.json()) as ResponseBody;
      let delivered = false;
      try {
        return await readStreamedRound(res, (delta) => {
          delivered = true;
          onDelta(delta);
        });
      } catch (err) {
        if (delivered || abortSignal?.aborted || attempt >= TRANSIENT_RETRIES) throw err;
        await backoff(attempt);
        continue;
      }
    }
    if (!RETRYABLE_STATUS.has(res.status) || attempt >= TRANSIENT_RETRIES) {
      throw new Error(await requestError(res));
    }
    await backoff(attempt);
  }
}

/** The route's SSE frames: deltas go out through onDelta as they land, and the
 * terminal `response.completed` frame is the return value. An `error` event or
 * a stream that ends without the terminal frame throws. */
async function readStreamedRound(
  res: Response,
  onDelta: (delta: string) => void
): Promise<ResponseBody> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Gemini returned no response stream.");
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: ResponseBody | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const split = buffer.indexOf("\n\n");
      if (split === -1) break;
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let isError = false;
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) isError = line.slice(7).trim() === "error";
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data || data === "[DONE]") continue;
      let event: { type?: string; delta?: string; response?: ResponseBody; message?: string };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        continue;
      }
      if (isError) throw new Error(event.message || "Gemini stream failed.");
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        onDelta(event.delta);
      } else if (event.type === "response.completed" && event.response) {
        completed = event.response;
      }
    }
  }
  if (!completed) throw new Error("Gemini stream ended early.");
  return completed;
}

const STEP_LIMIT_FALLBACK =
  'I got partway through and hit this turn’s step limit — say “keep going” and I’ll finish the rest.';

/** The loop ran out of tool rounds. One last call — tools withheld so it can't
 * keep looping — asks the model to hand back what it finished and what's left,
 * in its own voice, so the turn ends on a readable summary instead of a raw
 * error. A static line covers a failed or empty summary. */
async function emitStepLimitSummary({
  model,
  input,
  emit,
  textId,
  abortSignal,
}: {
  model: string;
  input: Item[];
  emit: (chunk: Record<string, unknown>) => void;
  textId: string;
  abortSignal?: AbortSignal;
}): Promise<void> {
  let text = STEP_LIMIT_FALLBACK;
  try {
    const summaryInput: Item[] = [
      ...input,
      {
        role: "user",
        content: [
          {
            text: 'You’ve reached this turn’s tool-step limit and can’t call more tools now. In one or two short sentences, in your normal voice, tell me what you got done and what still needs doing, and that I can say “keep going” to finish the rest.',
          },
        ],
      },
    ];
    const body = await postRound(
      { donkeyProvider: "gemini", model, instructions: systemPrompt(), input: summaryInput },
      abortSignal
    );
    const summary = (body.output_text ?? "").trim();
    if (summary) text = summary;
  } catch {
    // A failed summary falls back to the static handoff below.
  }
  emit({ type: "text-start", id: textId });
  emit({ type: "text-delta", id: textId, delta: text });
  emit({ type: "text-end", id: textId });
}

type Item = Record<string, unknown>;

/** The turn's tool gate: judge the newest message before the first round, and
 * withhold every tool declaration when it asks for nothing. A message carrying
 * attachments is work by construction (the user brought media to act on), so
 * it skips the model call. Single attempt, fails open to "work" — a classifier
 * hiccup must never block a real request. */
async function classifyTurnIntent(
  messages: UIMessage[],
  abortSignal?: AbortSignal
): Promise<TurnIntent> {
  const lastUser = messages.findLast((m) => m.role === "user");
  const attached = (lastUser?.metadata as { attachments?: unknown[] } | undefined)?.attachments;
  if (Array.isArray(attached) && attached.length > 0) return "work";
  const turns = messages.map((m) => ({
    role: m.role === "user" ? ("user" as const) : ("assistant" as const),
    text: m.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim(),
  }));
  try {
    const res = await hostedPost(
      "/api/inference/responses",
      {
        donkeyProvider: "gemini",
        model: geminiModelRoles.fastDecision,
        instructions: TURN_INTENT_PROMPT,
        input: turnIntentInput(turns),
      },
      abortSignal
    );
    if (!res.ok) return "work";
    const body = (await res.json()) as ResponseBody;
    return parseTurnIntent(body.output_text);
  } catch {
    return "work";
  }
}

const toolDeclarations = () =>
  AI_TOOLS.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));

/** The tools an assistant turn finished, read off its rendered parts. A call
 * that errored did no work, so it stays out and a retry stays open. */
function toolsRanIn(m: UIMessage): string[] {
  const parts = m.parts as unknown as { type: string; state?: string; toolName?: string }[];
  return parts.flatMap((p) => {
    const name =
      p.type === "dynamic-tool"
        ? p.toolName
        : p.type.startsWith("tool-")
          ? p.type.slice(5)
          : undefined;
    return name && p.state === "output-available" ? [name] : [];
  });
}

/** The conversation replayed as hosted-Responses input items. Past turns keep
 * their text plus a <tools_ran> ledger of what each reply executed — the tool
 * traffic itself (media payloads, thought signatures) stays within its own
 * turn, but the record of it has to survive or the model re-runs finished
 * work. The fresh editor snapshot rides on the newest user message alone, and
 * so do the attachments' actual payloads (video frames, images, audio,
 * text-file contents): older turns keep just the metadata JSON so replays stay
 * within budget. */
async function inputFromMessages(messages: UIMessage[]): Promise<Item[]> {
  const lastUser = messages.findLast((m) => m.role === "user");
  const items: Item[] = [];
  for (const m of messages) {
    let text = m.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim();
    const extra: Item[] = [];
    if (m.role === "user") {
      const meta = (m.metadata as { attachments?: unknown[] } | undefined)?.attachments;
      if (Array.isArray(meta) && meta.length > 0) {
        text += attachedAssetsBlock(meta);
        if (m === lastUser) {
          // Best-effort: a ref that no longer resolves (deleted asset, stale
          // object URL) degrades this turn to metadata-only instead of failing.
          const refs = meta.map(normalizeRef).filter((r) => r !== null);
          try {
            extra.push(...(await refsToParts(refs)).parts);
          } catch {}
        }
      }
      if (m === lastUser) {
        text += `\n\n<editor_state>\n${JSON.stringify(buildAiContext())}\n</editor_state>`;
      }
    } else {
      text += toolsRanBlock(toolsRanIn(m));
    }
    if (!text && extra.length === 0) continue;
    items.push({
      role: m.role === "user" ? "user" : "assistant",
      content: [...(text ? [{ text }] : []), ...extra],
    });
  }
  return items;
}

async function requestError(res: Response): Promise<string> {
  if (res.status === 401) {
    // Refresh the sign-in probe so the composer note (with its sign-in link) appears.
    useGenerate.getState().probe();
    return "Sign in to Donkey to chat with Gemini.";
  }
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
    details?: { message?: unknown } | null;
  } | null;
  // details.message carries the provider's real reason (e.g. the Vertex 400
  // text); the top-level message is only the generic headline, so prefer it.
  const message = [body?.details?.message, body?.message, body?.error].find(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  if (res.status === 402) return NO_CREDITS_MESSAGE;
  return message ?? "Gemini request failed.";
}

/** Server-side skills resolve locally; everything else runs on the editor store. */
async function execTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "list_skills") return { skills: AI_SKILL_INDEX };
  if (name === "read_skill") {
    const doc = AI_SKILLS[String(args.name ?? "")];
    if (!doc) throw new Error(`No such skill. Available: ${AI_SKILL_INDEX.join(", ")}`);
    return doc;
  }
  return runAiTool(name, args);
}

/** A tool result as content parts. The id pairs the function_response with its
 * originating call so Gemini matches responses to calls across parallel calls.
 *
 * Media (frames from watch_video and capture_frame, sound from listen_audio)
 * leaves the JSON — a data URL inlined as text would blow the token budget —
 * and returns via `mediaTurn`: a separate user turn shaped like a message
 * attachment. Gemini answers a turn that holds a functionResponse alongside
 * inline media by degenerating — one-token garbage for audio, and for frames
 * a prose paraphrase of the next tool call instead of the call — then stops.
 * The same media in its own turn gets the real reply. */
function functionResponseParts(
  name: string,
  output: unknown,
  id: string
): { parts: Item[]; mediaTurn: Item[] } {
  if (output && typeof output === "object" && "audio" in output) {
    const { audio, ...rest } = output as { audio?: unknown; name?: unknown };
    const m = typeof audio === "string" ? /^data:([^;,]+);base64,(.+)$/.exec(audio) : null;
    if (m) {
      const assetName = typeof rest.name === "string" ? rest.name : name;
      return {
        parts: [{ type: "function_response", id, name, response: rest }],
        mediaTurn: [
          { text: `Attached audio "${assetName}":` },
          { type: "input_audio", dataBase64: m[2], mimeType: m[1] },
        ],
      };
    }
  }
  if (output && typeof output === "object" && ("image" in output || "images" in output)) {
    const { image, images, ...rest } = output as {
      image?: unknown;
      images?: unknown;
      source?: { name?: unknown };
    };
    const parsed = [
      ...(typeof image === "string" ? [image] : []),
      ...(Array.isArray(images) ? images.filter((u): u is string => typeof u === "string") : []),
    ]
      .map((u) => /^data:([^;,]+);base64,(.+)$/.exec(u))
      .filter((m): m is RegExpExecArray => m !== null);
    if (parsed.length > 0) {
      const sourceName = typeof rest.source?.name === "string" ? rest.source.name : null;
      return {
        parts: [{ type: "function_response", id, name, response: rest }],
        mediaTurn: [
          { text: sourceName ? `Frames from ${name} of "${sourceName}":` : `Frames from ${name}:` },
          ...parsed.map((m) => ({ type: "input_image", dataBase64: m[2], mimeType: m[1] })),
        ],
      };
    }
  }
  const response =
    output && typeof output === "object" && !Array.isArray(output)
      ? output
      : { result: output ?? null };
  return { parts: [{ type: "function_response", id, name, response }], mediaTurn: [] };
}

interface ResponseBody {
  output_text?: string;
  output?: {
    type?: string;
    id?: string;
    name?: string;
    arguments?: unknown;
    thoughtSignature?: string;
  }[];
}

/** One chat turn: request → (tool round-trips) → reply, streamed as UI chunks. */
export function streamGeminiChat({
  model,
  messages,
  abortSignal,
}: {
  model: string;
  messages: UIMessage[];
  abortSignal?: AbortSignal;
}): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const emit = (chunk: Record<string, unknown>) =>
        controller.enqueue(chunk as unknown as UIMessageChunk);
      emit({ type: "start" });
      try {
        // The gate classifies while the input assembles; a "chat" verdict
        // (nothing asked) drops the tool declarations from the whole turn, so
        // the model can only answer in words.
        const intentPromise = classifyTurnIntent(messages, abortSignal);
        const input = await inputFromMessages(messages);
        const tools = (await intentPromise) === "work" ? toolDeclarations() : undefined;
        let textCount = 0;
        let settled = false;
        let emptyRounds = 0;
        // The scene-plan money gate, enforced structurally: a plan created this
        // turn cannot be approved this turn, whatever the model decides — the
        // user must see the plan card and answer (or click Approve) first.
        let scenePlannedThisTurn = false;

        for (let round = 0; round < MAX_TOOL_ROUNDS && !settled; round++) {
          // The round streams: text lands in the reply bubble as Gemini writes
          // it, instead of popping in whole seconds later when the round-trip
          // settles. The block opens on the first real (non-whitespace) delta,
          // matching the trim the settled body gets below.
          let textId: string | null = null;
          let body: ResponseBody;
          try {
            body = await postRound(
              { donkeyProvider: "gemini", model, instructions: systemPrompt(), input, ...(tools ? { tools } : {}) },
              abortSignal,
              (delta) => {
                if (!textId) {
                  if (!delta.trim()) return;
                  textId = `t${++textCount}`;
                  emit({ type: "text-start", id: textId });
                  delta = delta.trimStart();
                }
                emit({ type: "text-delta", id: textId, delta });
              }
            );
          } catch (err) {
            // Close a half-streamed block so the transcript stays well-formed
            // before the turn's error surfaces.
            if (textId) emit({ type: "text-end", id: textId });
            throw err;
          }

          const assistantParts: Item[] = [];
          const text = (body.output_text ?? "").trim();
          if (textId) {
            emit({ type: "text-end", id: textId });
            if (text) assistantParts.push({ text });
          } else if (text) {
            const id = `t${++textCount}`;
            emit({ type: "text-start", id });
            emit({ type: "text-delta", id, delta: text });
            emit({ type: "text-end", id });
            assistantParts.push({ text });
          }

          const calls = (body.output ?? []).filter((o) => o.type === "function_call");
          if (calls.length === 0) {
            // An empty STOP round with nothing said all turn: re-ask the same
            // input a couple of times — identical retries usually land — and
            // only then surface it, so the reply bubble never sits blank.
            if (textCount === 0 && emptyRounds < EMPTY_ROUND_RETRIES) {
              emptyRounds++;
              continue;
            }
            settled = true;
            if (textCount === 0) {
              emit({ type: "error", errorText: "Gemini returned an empty response. Try again." });
            }
            break;
          }

          // Parallel calls stay in one model turn, with every response in the
          // single user turn that follows — the shape Gemini expects back.
          // Tool media gathers separately and follows as its own user turn.
          const responseParts: Item[] = [];
          const mediaParts: Item[] = [];
          for (const call of calls) {
            const name = String(call.name ?? "unknown_function");
            const args =
              call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
                ? (call.arguments as Record<string, unknown>)
                : {};
            const toolCallId = call.id ? String(call.id) : crypto.randomUUID().slice(0, 12);
            // Replay the call with its id and Gemini-3 thought signature. The
            // signature is mandatory — Gemini 3 rejects the follow-up turn unless
            // each replayed call carries the exact signature it was issued with —
            // and the matching id pairs each response to its call.
            const assistantPart: Item = { functionCall: { id: toolCallId, name, args } };
            if (call.thoughtSignature) assistantPart.thoughtSignature = call.thoughtSignature;
            assistantParts.push(assistantPart);
            if (abortSignal?.aborted) return;
            emit({ type: "tool-input-available", toolCallId, toolName: name, input: args });
            try {
              const output =
                name === "approve_scene" && scenePlannedThisTurn
                  ? {
                      ok: false,
                      note:
                        "This plan landed this turn — the user hasn't answered yet. Ask them to confirm (they can also click Approve on the plan card), and call approve_scene only after they say yes in a later message.",
                    }
                  : await execTool(name, args);
              if (name === "generate_scene") scenePlannedThisTurn = true;
              // The transcript doesn't need listen_audio's payload — keep
              // megabyte data URLs out of thread state; the model still gets
              // the sound via functionResponseParts below.
              let uiOutput = output;
              if (output && typeof output === "object" && "audio" in output) {
                const { audio: _dropped, ...rest } = output as Record<string, unknown>;
                void _dropped;
                uiOutput = rest;
              }
              emit({ type: "tool-output-available", toolCallId, output: uiOutput ?? null });
              const { parts, mediaTurn } = functionResponseParts(name, output, toolCallId);
              responseParts.push(...parts);
              mediaParts.push(...mediaTurn);
            } catch (err) {
              const errorText = err instanceof Error ? err.message : String(err);
              emit({ type: "tool-output-error", toolCallId, errorText });
              responseParts.push(
                ...functionResponseParts(name, { error: errorText }, toolCallId).parts
              );
            }
          }
          input.push({ role: "assistant", content: assistantParts });
          input.push({ role: "user", content: responseParts });
          if (mediaParts.length > 0) input.push({ role: "user", content: mediaParts });
        }

        if (!settled && !abortSignal?.aborted) {
          await emitStepLimitSummary({
            model,
            input,
            emit,
            textId: `t${textCount + 1}`,
            abortSignal,
          });
        }
      } catch (err) {
        if (!abortSignal?.aborted) {
          emit({ type: "error", errorText: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        emit({ type: "finish" });
        controller.close();
      }
    },
  });
}
