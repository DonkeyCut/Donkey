import { localBackend } from "./backend/local";

export async function claimEngineTool(sessionKey: string | null, toolCallId: string): Promise<boolean> {
  const response = await localBackend.fetch("/api/cut/ai/tool-claim", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey, toolCallId }),
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
