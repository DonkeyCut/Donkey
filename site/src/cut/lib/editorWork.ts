/** A document load waits for tools already using its editor state to settle. */
const active = new Set<Promise<unknown>>();
let loading = 0;
const listeners = new Set<() => void>();

export function editorIsLoading(): boolean { return loading > 0; }
export function editorToolsActive(): boolean { return active.size > 0; }

export function watchEditorWork(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export async function holdEditorLoad(): Promise<() => void> {
  loading++;
  await Promise.allSettled([...active]);
  return () => {
    loading--;
    for (const fn of listeners) fn();
  };
}

export function trackEditorTool<T>(work: () => Promise<T>): Promise<T> {
  const result = work();
  active.add(result);
  void result.finally(() => active.delete(result)).catch(() => {});
  return result;
}

// The mounted editor owns its save queue. Scene work drains that same queue.
let editorSave: { projectId: string; flush: () => Promise<void> } | null = null;

export function registerEditorSave(projectId: string, flush: () => Promise<void>): () => void {
  const entry = { projectId, flush };
  editorSave = entry;
  return () => { if (editorSave === entry) editorSave = null; };
}

export async function flushEditorSave(projectId: string): Promise<void> {
  if (editorSave?.projectId === projectId) await editorSave.flush();
}

/** Closing drains tools and saves before a replacement editor can load. */
export function finishEditorWork(work: () => Promise<void>): Promise<void> {
  const ready = holdEditorLoad();
  return trackEditorTool(async () => {
    const release = await ready;
    try { await work(); } finally { release(); }
  });
}

const chats = new Map<string, number>();

export function editorChatActive(projectId: string): boolean {
  return chats.has(projectId);
}

/** Revision polling waits until this editor's conversations settle. */
export function holdEditorChat(projectId: string): () => void {
  chats.set(projectId, (chats.get(projectId) ?? 0) + 1);
  return () => {
    const remaining = (chats.get(projectId) ?? 1) - 1;
    if (remaining) chats.set(projectId, remaining);
    else chats.delete(projectId);
  };
}
