import { runAiTool } from "./aiTools";
import { editorIsLoading, trackEditorTool, watchEditorWork } from "./editorWork";
import { useEditor } from "./store";

/** A suspended turn waits for its own project to reopen before its next tool. */
export function waitForChatProject(projectId: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopStore = () => {};
    let stopWork = () => {};
    const clean = () => { stopStore(); stopWork(); signal?.removeEventListener("abort", check); };
    const check = () => {
      if (signal?.aborted) { clean(); reject(new DOMException("Stopped.", "AbortError")); return; }
      const s = useEditor.getState();
      if (!editorIsLoading() && s.projectId === projectId && s.loaded) { clean(); resolve(); }
    };
    stopStore = useEditor.subscribe(check);
    stopWork = watchEditorWork(check);
    signal?.addEventListener("abort", check, { once: true });
    check();
  });
}

export async function runProjectChatTool(projectId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  return withChatProject(projectId, () => runAiTool(name, args), signal);
}

export async function withChatProject<T>(projectId: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (;;) {
    await waitForChatProject(projectId, signal);
    signal?.throwIfAborted();
    if (editorIsLoading() || useEditor.getState().projectId !== projectId) continue;
    return trackEditorTool(work);
  }
}
