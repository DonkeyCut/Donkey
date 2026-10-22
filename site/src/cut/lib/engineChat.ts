import type { UIMessage } from "ai";
import { localBackend } from "./backend/local";
import { pendingAsk, type JournalMark } from "./chatResume";

/** This page among the tabs following a turn: the engine keeps a turn's tool
 * calls in the page that claimed its first one, whose project copy holds
 * what those calls made. */
const PAGE_ID = crypto.randomUUID();

export async function claimEngineTool(sessionKey: string | null, toolCallId: string): Promise<boolean> {
  const response = await localBackend.fetch("/api/cut/ai/tool-claim", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey, toolCallId, page: PAGE_ID }),
  });
  if (!response.ok) throw new Error("The Mac app could not attach this editor to the chat. Update the app and reconnect.");
  return (await response.json() as { claimed: boolean }).claimed;
}

export async function cancelEngineChat(projectId: string, threadId: string): Promise<void> {
  const response = await localBackend.fetch(`/api/cut/ai/chat/${encodeURIComponent(threadId)}/cancel`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId }),
  });
  if (!response.ok) throw new Error("Could not stop the chat on this Mac.");
}

/** Fold a message into the thread's running turn on this Mac. True once the
 * model has taken it; false when the turn ended first or the engine predates
 * folding — the message then goes out as its own turn. */
export async function foldIntoEngineChat(
  projectId: string,
  threadId: string,
  message: { text: string; attachments: unknown[]; context: unknown },
): Promise<boolean> {
  const response = await localBackend.fetch(`/api/cut/ai/chat/${encodeURIComponent(threadId)}/fold`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, ...message }),
  });
  if (!response.ok) return false;
  return (await response.json() as { folded: boolean }).folded;
}

/** Join the thread's turn that a reload or another tab left running on this
 * Mac, after the engine refused a new one for it: the message folds into that
 * turn and the page follows its journal. Null when the turn ended first, so
 * the message can go out as its own turn. */
export async function joinRunningEngineChat(
  projectId: string,
  threadId: string,
  body: { messages: UIMessage[]; context: unknown },
  signal?: AbortSignal,
): Promise<Response | null> {
  const { text, attachments } = pendingAsk(body.messages);
  if (!(await foldIntoEngineChat(projectId, threadId, { text, attachments, context: body.context }).catch(() => false))) return null;
  const response = await localBackend.fetch(
    `/api/cut/ai/chat/${encodeURIComponent(threadId)}/stream?projectId=${encodeURIComponent(projectId)}`,
    { signal },
  );
  return response.ok && response.status !== 204 ? response : null;
}

/** How far the engine's journal of the thread's newest turn reaches, and
 * whether that turn still runs. Null when the engine keeps no journal for the
 * thread, cannot be reached, or predates peeking (it answers with the stream
 * itself, which is left unread). */
export async function peekEngineChat(projectId: string, threadId: string): Promise<(JournalMark & { running: boolean }) | null> {
  const response = await localBackend.fetch(
    `/api/cut/ai/chat/${encodeURIComponent(threadId)}/stream?projectId=${encodeURIComponent(projectId)}&peek=1`,
  ).catch(() => null);
  if (!response?.ok || !response.headers.get("Content-Type")?.includes("application/json")) {
    void response?.body?.cancel().catch(() => {});
    return null;
  }
  const { journal } = await response.json().catch(() => ({})) as { journal?: { messageId?: unknown; chunks?: unknown; running?: unknown } | null };
  if (typeof journal?.messageId !== "string" || typeof journal.chunks !== "number") return null;
  return { messageId: journal.messageId, chunks: journal.chunks, running: journal.running === true };
}

/** Answer the engine's quality gate for a signing-off turn: the steer for its
 * next pass, or null to let it close. A gate the engine no longer holds is
 * dropped. */
export async function answerEngineGate(sessionKey: string, gateId: string, steer: string | null): Promise<void> {
  await localBackend.fetch("/api/cut/ai/gate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey, gateId, steer }),
  });
}
