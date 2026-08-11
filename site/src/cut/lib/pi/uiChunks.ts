import type { Agent } from "@earendil-works/pi-agent-core";
import type { DonkeyToolDetails } from "./donkeyStream";

// The bridge from pi agent events to the AI-SDK UIMessageChunk stream AiPanel
// already consumes: text opens/streams/closes per content block, tool calls
// surface as input/output chunks, and the whole turn rides one start…finish
// envelope emitted by the caller.

export type EmitChunk = (chunk: Record<string, unknown>) => void;

export function subscribeUiChunks(agent: Agent, emit: EmitChunk): () => void {
  let textCount = 0;
  // pi indexes text blocks per assistant message; the UI wants globally unique
  // ids across the turn's rounds.
  const openText = new Map<number, string>();
  return agent.subscribe((event) => {
    if (event.type === "message_update") {
      const e = event.assistantMessageEvent;
      if (e.type === "text_start") {
        const id = `t${++textCount}`;
        openText.set(e.contentIndex, id);
        emit({ type: "text-start", id });
      } else if (e.type === "text_delta") {
        const id = openText.get(e.contentIndex);
        if (id) emit({ type: "text-delta", id, delta: e.delta });
      } else if (e.type === "text_end") {
        const id = openText.get(e.contentIndex);
        if (id) {
          emit({ type: "text-end", id });
          openText.delete(e.contentIndex);
        }
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      emit({
        type: "tool-input-available",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args,
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      const result = event.result as
        | { content?: { type: string; text?: string }[]; details?: DonkeyToolDetails }
        | undefined;
      if (event.isError) {
        const text = result?.content?.find((c) => c.type === "text")?.text;
        emit({
          type: "tool-output-error",
          toolCallId: event.toolCallId,
          errorText: text || "Tool failed.",
        });
      } else {
        emit({
          type: "tool-output-available",
          toolCallId: event.toolCallId,
          output: result?.details?.response ?? null,
        });
      }
      return;
    }
    if (event.type === "message_end") {
      // A round that ended without a clean text_end (an error mid-stream)
      // still closes its open blocks so the transcript stays well-formed.
      for (const id of openText.values()) emit({ type: "text-end", id });
      openText.clear();
    }
  });
}
