"use client";

import { useEffect } from "react";
import { chatgptPolling } from "@/cut/lib/chatRuntime";
import { hostCommandPoller } from "@/cut/lib/hostCommandPolling";
import { runAiTool } from "./aiTools";
import { apiFetch } from "./backend";
import { runCommandBatch, type CommandJobSpec } from "./commandBatch";
import { flushEditorSave } from "./editorWork";
import { withChatProject } from "./projectChatTools";
import { projectRevision } from "./projectRevision";
import { serializeDoc, useEditor } from "./store";

/**
 * The editor inside the ChatGPT card runs the batches ChatGPT sends. A tool
 * call queues a batch for the project; this editor claims it, runs each
 * command on the open document through the same executors the chat uses,
 * saves, and reports the outcome, which the tool call then returns to
 * ChatGPT. Each batch is one undo step here, so the user's own ⌘Z and
 * ChatGPT's undo agree on what a step is.
 */
const HEARTBEAT_MS = 10_000;

const snapshot = () => JSON.stringify(serializeDoc(useEditor.getState()));

const postJson = (path: string, body: unknown, init: RequestInit = {}) =>
  apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...init });

type Report = { ok: true; results: unknown[]; changed: boolean; docVersion: string | null } | { ok: false; error: string };

/** The claimed batch's line to the server: heartbeats while it runs, and one
 * report when it ends. A heartbeat the server refuses means the batch is no
 * longer this editor's (expired, canceled), so the run is aborted. */
function claimedJobReporter(id: string, abort: () => void) {
  const beat = window.setInterval(() => {
    void postJson(`/api/cut/jobs/${id}/heartbeat`, {})
      .then((res) => { if (res.status === 409) abort(); })
      .catch(() => {});
  }, HEARTBEAT_MS);
  return {
    stop: () => window.clearInterval(beat),
    /** One retry covers a dropped connection; past that the server's own
     * heartbeat expiry closes the batch. */
    async report(body: Report, init: RequestInit = {}): Promise<void> {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await postJson(`/api/cut/jobs/${id}/result`, body, init);
          if (res.ok || res.status === 409) return;
        } catch {
          // Retry below.
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
  };
}

/** Run the batch on the open document as one undo step and save. */
async function runBatchInEditor(projectId: string, spec: CommandJobSpec, signal: AbortSignal): Promise<Report> {
  return withChatProject(projectId, async () => {
    const before = snapshot();
    if (!spec.readOnly) useEditor.getState().beginHistoryBatch();
    let results;
    try {
      results = await runCommandBatch(projectId, spec.commands, (name, input) => runAiTool(name, input), { isCanceled: () => signal.aborted });
    } finally {
      if (!spec.readOnly) useEditor.getState().endHistoryBatch();
    }
    const changed = !spec.readOnly && snapshot() !== before;
    let docVersion: string | null = null;
    if (changed) {
      await flushEditorSave(projectId);
      // A keystroke during the save leaves the state dirty again; only a
      // failed PUT means the batch's edit did not land.
      if (useEditor.getState().saveState === "error") throw new Error("The edit could not be saved.");
      docVersion = projectRevision(projectId);
    }
    return { ok: true, results, changed, docVersion };
  }, signal);
}

async function runClaimed(projectId: string, id: string, spec: CommandJobSpec, parent: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parent.addEventListener("abort", onParentAbort);
  const line = claimedJobReporter(id, () => controller.abort());
  try {
    const report = await runBatchInEditor(projectId, spec, controller.signal);
    await line.report(report);
  } catch (err) {
    if (parent.aborted) {
      // The card is closing mid-batch: tell the server so the batch ends now
      // rather than at the heartbeat expiry. keepalive lets the request
      // outlive the page.
      await line.report({ ok: false, error: "The editor closed before the batch finished." }, { keepalive: true });
      return;
    }
    if (!controller.signal.aborted)
      await line.report({ ok: false, error: err instanceof Error ? err.message : String(err) });
  } finally {
    line.stop();
    parent.removeEventListener("abort", onParentAbort);
  }
}

/** Poll for batches queued on this project and run them, while the editor
 * is hosted by ChatGPT with a cloud project open. */
export function useHostCommands(projectId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer = 0;
    const schedule = (ms: number) => {
      if (!signal.aborted) timer = window.setTimeout(tick, ms);
    };
    const poll = hostCommandPoller({
      claim: () => apiFetch(`/api/cut/projects/${projectId}/commands/claim`, { method: "POST", signal }),
      run: (job) => runClaimed(projectId, job.id, job.spec, signal),
      settings: chatgptPolling,
      hidden: () => document.hidden,
    });
    const tick = async () => {
      if (signal.aborted) return;
      const delay = await poll();
      if (delay !== null) schedule(delay);
    };
    schedule(0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [projectId, enabled]);
}
