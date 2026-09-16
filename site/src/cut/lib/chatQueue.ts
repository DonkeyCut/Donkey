"use client";

import { chatOwner } from "./chatAssets";

// The composer queue as a tool target. The running agent can put a message
// on it — one it cannot do yet, because it needs this turn's finished result
// or a fresh look at the project after the cuts land — and the row goes out
// as its own turn once the running one settles, exactly like a message the
// user parked there. The queue is React state inside each thread's session,
// so a session registers a sink while mounted and the tool finds the sink
// through the streaming turn's thread.

const sinks = new Map<string, (text: string) => void>();

/** Register the mounted session's queue for its thread; returns the release. */
export function registerQueueSink(threadId: string, sink: (text: string) => void): () => void {
  sinks.set(threadId, sink);
  return () => {
    if (sinks.get(threadId) === sink) sinks.delete(threadId);
  };
}

/** Put a message on the streaming turn's queue. Throws where no session
 * holds a queue — a headless job has no composer and nobody to run the row
 * later, so the model does the work now or says what remains. */
export function queueMessageFromAgent(text: string): void {
  const sink = sinks.get(chatOwner() ?? "");
  if (!sink) throw new Error("No composer queue on this surface — do the work now, or say what remains.");
  sink(text);
}
