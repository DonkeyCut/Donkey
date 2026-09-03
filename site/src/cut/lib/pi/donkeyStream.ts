import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import { reportBalance } from "../hosted";
import type { DonkeyModel } from "./donkeyModel";

// The transport adapter: pi Context in, Donkey's hosted Responses route out.
// Every model call the agent makes flows through here — pi's own providers are
// never involved — so this file is where the wire quirks live:
// - each replayed assistant toolCall carries its exact thoughtSignature
//   (Gemini 3 rejects the follow-up turn without it);
// - tool-result media rides a separate user turn AFTER the function_response
//   (media sharing a turn with a functionResponse makes Gemini degenerate);
// - consecutive tool results collapse into one user turn (the shape Gemini
//   expects back for parallel calls).

/** A wire content part (the hosted route's item-content shape). */
export type WirePart = Record<string, unknown>;

/** Extra wire parts a user message carries beyond pi's text/image content —
 * attachment audio, pinned segments — emitted verbatim after the text. */
export interface WireCarrier {
  wireParts?: WirePart[];
}

/** ToolResultMessage.details as the tool bridge writes it: the JSON the model
 * gets back, plus any media parts that must ride their own following turn. */
export interface DonkeyToolDetails {
  response: unknown;
  mediaParts?: WirePart[];
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

export type PostFn = (
  payload: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<Response>;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_RETRIES = 2;
// Gemini can return an empty STOP round — no text, no tool calls. Identical
// re-asks usually land, so the stream retries before surfacing anything.
const EMPTY_ROUND_RETRIES = 2;

const backoff = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 600 * (attempt + 1)));

const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** pi messages serialized as the route's input items. */
export function serializeMessages(messages: Message[]): WirePart[] {
  const items: WirePart[] = [];
  // Consecutive toolResult messages gather into ONE user turn of
  // function_responses, with their media following as its own user turn.
  let responseParts: WirePart[] = [];
  let mediaParts: WirePart[] = [];
  const flushResults = () => {
    if (responseParts.length > 0) items.push({ role: "user", content: responseParts });
    if (mediaParts.length > 0) items.push({ role: "user", content: mediaParts });
    responseParts = [];
    mediaParts = [];
  };
  for (const m of messages) {
    if (m.role === "toolResult") {
      const details = (m.details ?? {}) as DonkeyToolDetails;
      const response =
        details.response && typeof details.response === "object" && !Array.isArray(details.response)
          ? details.response
          : { result: details.response ?? null };
      responseParts.push({
        type: "function_response",
        id: m.toolCallId,
        name: m.toolName,
        response: m.isError
          ? { error: m.content.find((c) => c.type === "text")?.text ?? "Tool failed." }
          : response,
      });
      if (details.mediaParts?.length) mediaParts.push(...details.mediaParts);
      continue;
    }
    flushResults();
    if (m.role === "user") {
      const parts: WirePart[] = [];
      if (typeof m.content === "string") {
        if (m.content) parts.push({ text: m.content });
      } else {
        for (const c of m.content) {
          if (c.type === "text") parts.push({ text: c.text });
          else parts.push({ type: "input_image", dataBase64: c.data, mimeType: c.mimeType });
        }
      }
      parts.push(...((m as WireCarrier).wireParts ?? []));
      if (parts.length > 0) items.push({ role: "user", content: parts });
      continue;
    }
    // assistant
    const parts: WirePart[] = [];
    for (const c of m.content) {
      if (c.type === "text") {
        if (c.text.trim()) parts.push({ text: c.text.trim() });
      } else if (c.type === "toolCall") {
        const part: WirePart = {
          functionCall: { id: c.id, name: c.name, args: c.arguments },
        };
        if (c.thoughtSignature) part.thoughtSignature = c.thoughtSignature;
        parts.push(part);
      }
      // thinking blocks stay out of the replay, matching the current loop.
    }
    if (parts.length > 0) items.push({ role: "assistant", content: parts });
  }
  flushResults();
  return items;
}

/** The route's SSE frames: text deltas out through onDelta, the terminal
 * `response.completed` frame is the return value. */
async function readStream(
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
      let event: {
        type?: string;
        delta?: string;
        response?: ResponseBody;
        message?: string;
        creditsRemaining?: string;
      };
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
        reportBalance(event.creditsRemaining);
      }
    }
  }
  if (!completed) throw new Error("Gemini stream ended early.");
  return completed;
}

async function requestError(
  res: Response,
  onAuthFail?: () => void
): Promise<string> {
  if (res.status === 401) {
    onAuthFail?.();
    return "Sign in to Donkey to chat with Gemini.";
  }
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
    details?: { message?: unknown } | null;
  } | null;
  const message = [body?.details?.message, body?.message, body?.error].find(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  if (res.status === 402)
    return message ?? "You're out of Donkey credits — top up to keep generating.";
  return message ?? "Gemini request failed.";
}

export interface DonkeyStreamDeps {
  post: PostFn;
  /** 401 hook (production refreshes the sign-in probe so the composer note appears). */
  onAuthFail?: () => void;
  /** Out-of-credits message override (production shows its standard line). */
  noCreditsMessage?: string;
}

/** The StreamFn the Agent runs on. Failures are encoded in the stream per pi's
 * contract; transient upstream errors retry before the first delivered delta,
 * and an empty STOP round re-asks a couple of times. */
export function makeDonkeyStream(deps: DonkeyStreamDeps) {
  // Whether any round this turn streamed visible text. An empty round after a
  // reply already landed settles quietly; erroring would tear down text the
  // user already read.
  let turnHadText = false;
  return (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
    let ended = false;
    const fail = (reason: "error" | "aborted", message: string) => {
      if (ended) return;
      ended = true;
      partial.stopReason = reason;
      partial.errorMessage = message;
      stream.push({ type: "error", reason, error: partial });
      stream.end(partial);
    };

    void (async () => {
      const payload: Record<string, unknown> = {
        donkeyProvider: "gemini",
        model: model.id,
        instructions: context.systemPrompt ?? "",
        input: serializeMessages(context.messages),
        stream: true,
      };
      const thinkingLevel = (model as DonkeyModel).thinkingLevel;
      if (thinkingLevel) payload.thinking_level = thinkingLevel;
      if (context.tools && context.tools.length > 0) {
        payload.tools = context.tools.map((t) => ({
          type: "function",
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }));
      }
      const signal = options?.signal;
      // `start` goes out at request time so the agent's message window — and
      // the eval's round clock — covers the whole round trip.
      stream.push({ type: "start", partial });
      let textIndex: number | null = null;
      let streamedText = "";
      const onDelta = (delta: string) => {
        if (textIndex === null) {
          if (!delta.trim()) return;
          delta = delta.trimStart();
          textIndex = partial.content.length;
          partial.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: textIndex, partial });
          turnHadText = true;
        }
        streamedText += delta;
        (partial.content[textIndex] as { text: string }).text = streamedText;
        stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial });
      };

      let attempt = 0;
      let emptyRounds = 0;
      for (;;) {
        if (signal?.aborted) return fail("aborted", "Stopped.");
        let res: Response;
        try {
          res = await deps.post(payload, signal);
        } catch (err) {
          if (signal?.aborted) return fail("aborted", "Stopped.");
          if (attempt >= TRANSIENT_RETRIES)
            return fail("error", err instanceof Error ? err.message : String(err));
          await backoff(attempt++);
          continue;
        }
        if (!res.ok) {
          if (RETRYABLE_STATUS.has(res.status) && attempt < TRANSIENT_RETRIES) {
            await backoff(attempt++);
            continue;
          }
          let message = await requestError(res, deps.onAuthFail);
          if (res.status === 402 && deps.noCreditsMessage) message = deps.noCreditsMessage;
          return fail("error", message);
        }
        let body: ResponseBody;
        try {
          body = await readStream(res, onDelta);
        } catch (err) {
          if (signal?.aborted) return fail("aborted", "Stopped.");
          // A broken stream retries only while nothing has been shown.
          if (textIndex !== null || attempt >= TRANSIENT_RETRIES)
            return fail("error", err instanceof Error ? err.message : String(err));
          await backoff(attempt++);
          continue;
        }

        const settled = (body.output_text ?? "").trim();
        const calls = (body.output ?? []).filter((o) => o.type === "function_call");
        if (!settled && calls.length === 0 && textIndex === null) {
          if (emptyRounds < EMPTY_ROUND_RETRIES) {
            emptyRounds++;
            continue;
          }
          // An empty round in a turn that already streamed a reply settles as
          // a quiet stop; a turn with nothing said at all is a real failure.
          if (!turnHadText) return fail("error", "Gemini returned an empty response. Try again.");
        }

        if (textIndex === null && settled) {
          onDelta(settled);
        } else if (textIndex !== null && settled) {
          // The settled body is canonical; reconcile any tail the stream missed.
          if (settled !== streamedText && settled.startsWith(streamedText)) {
            const tail = settled.slice(streamedText.length);
            if (tail) {
              streamedText = settled;
              (partial.content[textIndex] as { text: string }).text = settled;
              stream.push({ type: "text_delta", contentIndex: textIndex, delta: tail, partial });
            }
          }
        }
        if (textIndex !== null) {
          stream.push({ type: "text_end", contentIndex: textIndex, content: streamedText, partial });
        }

        for (const call of calls) {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: call.id ? String(call.id) : crypto.randomUUID().slice(0, 12),
            name: String(call.name ?? "unknown_function"),
            arguments:
              call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
                ? (call.arguments as Record<string, unknown>)
                : {},
          };
          if (call.thoughtSignature) toolCall.thoughtSignature = call.thoughtSignature;
          const contentIndex = partial.content.length;
          partial.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex, partial });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
        }

        partial.stopReason = calls.length > 0 ? "toolUse" : "stop";
        stream.push({ type: "done", reason: partial.stopReason, message: partial });
        ended = true;
        stream.end(partial);
        return;
      }
    })().catch((err) => {
      fail("error", err instanceof Error ? err.message : String(err));
    });

    return stream;
  };
}
