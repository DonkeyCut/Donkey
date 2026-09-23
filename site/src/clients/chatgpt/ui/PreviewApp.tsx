import { ArtifactVideo } from "@donkeycut/artifact-player/ArtifactVideo";
import { useEffect, useRef, useState } from "react";
import { useProjectApp } from "./useProjectApp";
import "./preview.css";

export function PreviewApp() {
  const { ready, view, playback, editor, fullscreen, hostInset, error, busy, visible, run, playbackFailed, openDonkey, openFromFrame, saveFromFrame, requestFullscreen, retryEditor } = useProjectApp();
  const project = view?.project;
  const preview = view?.preview;
  const rendering = preview?.status === "queued" || preview?.status === "running";
  // The frame whose editor has said it is on screen.
  const [shown, setShown] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // An editable project is the editor, and its own chrome carries every
  // control. The card holds the editor's inline space from the first paint,
  // so a card ChatGPT shows again after a reload is the editor while it
  // fetches a fresh link. The editor's skeleton covers the frame until the
  // frame reports something to see.
  if (view ? project && view.canEdit : !error) {
    const loading = !editor || shown !== editor.url;
    return <main className="editing" data-mode={fullscreen ? "fullscreen" : "inline"} aria-busy={loading}>
      {editor && project && <EditorFrame key={editor.url} url={editor.url} name={project.name} inset={hostInset} fullscreen={fullscreen} onReady={() => setShown(editor.url)} onFullscreen={requestFullscreen} onOpen={openFromFrame} onSave={saveFromFrame} onDownloadError={setDownloadError} />}
      {downloadError && <div className="download-error"><p role="alert">{downloadError}</p><button onClick={() => setDownloadError(null)}>Dismiss</button></div>}
      {error && project && !editor
        ? <div className="waiting">
          <p role="alert">{error}</p>
          <button disabled={busy || !ready} onClick={retryEditor}>Try again</button>
        </div>
        : loading && <EditorSkeleton />}
    </main>;
  }
  return <main aria-busy={busy}>
    <header><span className="brand">Donkey Cut</span><span>Cloud projects</span></header>
    {error && <p role="alert" className="error">{error}</p>}
    {!view && <p role="status">{ready ? "Choose a project to preview." : "Connecting to Donkey Cut…"}</p>}
    {!view && ready && <button onClick={() => void run("list_projects", {})}>Load projects</button>}
    {view?.view === "projects" && <>
      <h1>Your projects</h1>
      {view.projects.length === 0 && <p>Save a project to the cloud in Donkey Cut to preview it here.</p>}
      <div className="projects">{view.projects.map((p) => <button key={p.id} disabled={busy || !ready} onClick={() => void run("open_project", { projectId: p.id })}>
        <span>{p.name}</span><span aria-hidden="true">→</span>
      </button>)}</div>
      <nav>{view.nextCursor && <button disabled={busy} onClick={() => void run("list_projects", { cursor: view.nextCursor! })}>More projects</button>}
        <button disabled={busy || !ready} onClick={() => void run("list_projects", {})}>Refresh list</button></nav>
    </>}
    {project && <>
      <h1>{project.name}</h1>
      {playback && <ArtifactVideo src={playback.url} format="file" active={visible} onError={playbackFailed} aria-label={`Preview of ${project.name}`} />}
      {rendering && <div role="status"><p>{preview.status === "queued" ? "Waiting to render…" : `Rendering preview… ${Math.round(preview.progress * 100)}%`}</p><progress max={1} value={preview.progress} /></div>}
      {!preview && <p>Render a preview to watch this project here.</p>}
      {preview?.status === "expired" && <p>This preview has expired. Render it again to watch.</p>}
      {preview?.status === "error" && <p role="alert">{preview.error}</p>}
      {preview?.status === "done" && preview.revision !== project.revision && <p className="muted">This preview may be from an earlier edit.</p>}
      <nav>
        {view.canRender && <button className="primary" disabled={busy || rendering || !ready} onClick={() => void run("render_preview", { projectId: project.id })}>Render preview</button>}
        <button disabled={!ready} onClick={() => openDonkey()}>Open in Donkey Cut ↗</button>
        <button disabled={busy || !ready} onClick={() => void run("list_projects", {})}>Projects</button>
        {error && <button disabled={busy || !ready} onClick={() => void run("open_project", { projectId: project.id })}>Try again</button>}
      </nav>
    </>}
  </main>;
}

/** The editor's shape in its own white while it loads: the top bar, the tab
 * rail, the preview and the timeline, drawn as the site's skeleton slabs. */
function EditorSkeleton() {
  return <div className="skeleton" role="status" aria-label="Opening the editor">
    <div className="bar"><i className="slab" /><i className="slab" /><span /><i className="slab" /><i className="slab" /></div>
    <div className="rail">{[0, 1, 2, 3, 4].map((i) => <i key={i} className="slab" />)}</div>
    <div className="stage"><i className="slab" /></div>
    <div className="timeline">
      <div className="controls"><i className="slab" /><i className="slab" /><i className="slab" /></div>
      {[0, 1, 2].map((i) => <div key={i} className="track"><i className="slab" /><i className="slab" /></div>)}
    </div>
  </div>;
}

/** The editor, framed. It learns the host's display mode and how tall the
 * bottom overlay is when it loads, whenever that changes, and whenever it
 * asks; it says when it has something on screen, and its own toolbar asks
 * for fullscreen, for a tab on donkeycut.com, and for the saves the sandbox
 * blocks inside the frame. */
function EditorFrame({ url, name, inset, fullscreen, onReady, onFullscreen, onOpen, onSave, onDownloadError }: { url: string; name: string; inset: number; fullscreen: boolean; onReady: () => void; onFullscreen: () => void; onOpen: (url: string) => void; onSave: (text: string, name: string, mimeType: string) => void; onDownloadError: (message: string | null) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const origin = new URL(url).origin;
  const tell = () => frame.current?.contentWindow?.postMessage({ type: "donkeycut:host", insetBottom: inset, displayMode: fullscreen ? "fullscreen" : "inline" }, origin);
  useEffect(tell, [inset, fullscreen, origin]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "donkeycut:host?") tell();
      if (event.data?.type === "donkeycut:ready") onReady();
      if (event.data?.type === "donkeycut:fullscreen") onFullscreen();
      if (event.data?.type === "donkeycut:download-error" && (event.data.message === null || typeof event.data.message === "string")) onDownloadError(event.data.message);
      // The frame is the editor on this origin, so what it asks to open is
      // the editor's own link — a project page, an export, the post a clip
      // came from. Only the scheme is worth checking.
      if (event.data?.type === "donkeycut:open" && typeof event.data.url === "string") {
        const target = URL.parse(event.data.url);
        if (target?.protocol === "https:" || target?.protocol === "http:") onOpen(target.toString());
      }
      if (event.data?.type === "donkeycut:save" && typeof event.data.text === "string") {
        const { text, name: file, mimeType } = event.data as { text: string; name?: unknown; mimeType?: unknown };
        if (typeof file === "string" && typeof mimeType === "string") onSave(text, file, mimeType);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });
  return <iframe ref={frame} className="editor" src={url} onLoad={tell} title={`Editing ${name}`} allow="fullscreen; clipboard-read; clipboard-write" />;
}
