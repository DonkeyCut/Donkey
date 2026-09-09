/** Active browser turns outlive their panel; a reopened panel observes the same run. */
const turns = new Map<string, AbortController>();
const listeners = new Set<() => void>();
const keyFor = (projectId: string, threadId: string) => `${projectId}/${threadId}`;
const publish = () => { for (const listener of listeners) listener(); };

export function watchBrowserChatTurns(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function browserChatRunning(projectId: string, threadId: string): boolean {
  return turns.has(keyFor(projectId, threadId));
}

export function cancelBrowserChat(projectId: string, threadId: string): void {
  turns.get(keyFor(projectId, threadId))?.abort();
}

export function beginBrowserChat(projectId: string, threadId: string, source?: AbortSignal) {
  const key = keyFor(projectId, threadId);
  if (turns.has(key)) throw new Error("This conversation is already working.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  source?.addEventListener("abort", abort, { once: true });
  if (source?.aborted) abort();
  turns.set(key, controller);
  publish();
  return {
    signal: controller.signal,
    finish: () => {
      source?.removeEventListener("abort", abort);
      if (turns.get(key) === controller) { turns.delete(key); publish(); }
    },
  };
}
