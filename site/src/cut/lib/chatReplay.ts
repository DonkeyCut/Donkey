import type { UIMessageChunk } from "ai";

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
