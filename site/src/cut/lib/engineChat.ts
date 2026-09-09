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
