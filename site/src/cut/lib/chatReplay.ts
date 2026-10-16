import type { UIMessageChunk } from "ai";
import type { StreamedMark } from "./chatResume";

// The chunks that close an engine journal: nothing follows them but [DONE].
const CLOSING_CHUNKS = new Set<UIMessageChunk["type"]>(["finish", "error", "abort"]);

/** Count the chunks an engine turn's stream hands the chat. The engine's
 * journal counts the same chunks, so a finished turn's count is the mark its
 * saved thread keeps (see journalAhead and settledMark). */
export function countChunks(source: ReadableStream<UIMessageChunk>, count: (mark: StreamedMark) => void): ReadableStream<UIMessageChunk> {
  let mark: StreamedMark | null = null;
  return source.pipeThrough(new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type === "start" && chunk.messageId) mark = { messageId: chunk.messageId, chunks: 0, ended: false };
      if (mark) count(mark = { ...mark, chunks: mark.chunks + 1, ended: CLOSING_CHUNKS.has(chunk.type) });
      controller.enqueue(chunk);
    },
  }));
}

/** Read the journal identity before the SDK snapshots its current assistant message. */
export async function replayChatStream(
  source: ReadableStream<UIMessageChunk>,
  prepare: (messageId: string, requestId: string | undefined) => boolean,
  attach: (close: () => void) => void,
  completedMessageId?: string,
): Promise<ReadableStream<UIMessageChunk> | null> {
  const reader = source.getReader();
  const cancel = async () => { try { await reader.cancel(); } finally { reader.releaseLock(); } };
  const first = await reader.read().catch((error) => { reader.releaseLock(); throw error; });
  if (first.done || first.value.type !== "start" || !first.value.messageId || first.value.messageId === completedMessageId || !prepare(
    first.value.messageId,
    (first.value.messageMetadata as { requestMessageId?: string } | undefined)?.requestMessageId,
  )) {
    await cancel();
    return null;
  }
  let closed = false;
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue(first.value);
      attach(() => {
        if (closed) return;
        closed = true;
        void cancel().catch(() => {});
        controller.close();
      });
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) { closed = true; controller.close(); reader.releaseLock(); }
        else controller.enqueue(next.value);
      } catch (error) { if (!closed) { closed = true; reader.releaseLock(); controller.error(error); } }
    },
    async cancel() { closed = true; await cancel(); },
  });
}
