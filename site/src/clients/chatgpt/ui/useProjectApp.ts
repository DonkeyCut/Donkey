import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "@modelcontextprotocol/ext-apps";
import { playbackSchema, viewSchema, type Playback, type ProjectView } from "../contracts";

type ToolResult = { isError?: boolean; structuredContent?: unknown; _meta?: Record<string, unknown>; content?: unknown[] };

/** The host carries authentication; the iframe only calls the MCP Apps bridge. */
export function useProjectApp() {
  const appRef = useRef<App | null>(null);
  const epoch = useRef(0);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<ProjectView | null>(null);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const [pollMs, setPollMs] = useState(2000);
  const recoveries = useRef(0);

  const receive = useCallback((result: ToolResult) => {
    if (result.isError) throw new Error("Donkey Cut could not complete this request. Try again.");
    const parsed = viewSchema.safeParse(result.structuredContent);
    if (!parsed.success) throw new Error("The preview response could not be read.");
    const media = playbackSchema.safeParse(result._meta?.playback);
    const interval = result._meta?.pollMs;
    if (typeof interval === "number" && interval >= 1000 && interval <= 30000) setPollMs(interval);
    setView(parsed.data);
    setPlayback(media.success ? media.data : null);
    setError(null);
  }, []);

  useEffect(() => {
    const app = new App({ name: "Donkey Cut preview", version: "1.0.0" }, {}, { strict: true });
    appRef.current = app;
    let live = true;
    app.ontoolresult = (result) => {
      if (!live) return;
      epoch.current++;
      recoveries.current = 0;
      setBusy(false);
      try { receive(result); } catch (e) { setError((e as Error).message); }
    };
    app.onhostcontextchanged = ({ theme }) => { if (theme) document.documentElement.dataset.theme = theme; };
    void app.connect().then(() => {
      if (!live) return;
      document.documentElement.dataset.theme = app.getHostContext()?.theme ?? "light";
      setReady(true);
    }).catch(() => { if (live) setError("Connect this preview from ChatGPT to continue."); });
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      live = false;
      appRef.current = null;
      document.removeEventListener("visibilitychange", visibility);
      void app.close().catch(() => {});
    };
  }, [receive]);

  const run = useCallback(async (name: string, args: Record<string, string>, manual = true) => {
    const app = appRef.current;
    if (!app || !ready) return;
    const current = ++epoch.current;
    if (manual) { recoveries.current = 0; setBusy(true); setError(null); }
    try {
      const result = await app.callServerTool({ name, arguments: args });
      if (current === epoch.current && appRef.current === app) receive(result);
    } catch (e) {
      if (current === epoch.current && appRef.current === app) setError(e instanceof Error ? e.message : "Request failed.");
    } finally { if (current === epoch.current && appRef.current === app) setBusy(false); }
  }, [ready, receive]);

  const projectId = view?.project?.id;
  const jobId = view?.preview?.id;
  const status = view?.preview?.status;
  useEffect(() => {
    if (!ready || !visible || busy || error || !projectId || !jobId) return;
    const waiting = status === "queued" || status === "running";
    if (!waiting && !playback) return;
    const delay = waiting ? pollMs : Math.max(1000, playback!.expiresAt - Date.now() - 60000);
    const timeout = window.setTimeout(() => { void run("get_preview_status", { projectId, jobId }, false); }, delay);
    return () => window.clearTimeout(timeout);
  }, [ready, visible, busy, error, projectId, jobId, status, playback, pollMs, run, view]);

  const playbackFailed = useCallback(() => {
    if (!projectId || !jobId) return;
    if (recoveries.current++ >= 1) { setError("Video could not load. Try opening the project again."); return; }
    setPlayback(null);
    void run("get_preview_status", { projectId, jobId }, false);
  }, [projectId, jobId, run]);

  const openDonkey = async () => {
    if (!view?.project || !appRef.current) return;
    try { const result = await appRef.current.openLink({ url: view.project.url }); if (result.isError) setError("Could not open Donkey Cut."); }
    catch { setError("Could not open Donkey Cut."); }
  };
  return { ready, view, playback, error, busy, visible, run, playbackFailed, openDonkey };
}
