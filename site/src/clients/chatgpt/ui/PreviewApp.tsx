import { ArtifactVideo } from "@donkeycut/artifact-player/ArtifactVideo";
import { useProjectApp } from "./useProjectApp";
import "./preview.css";

export function PreviewApp() {
  const { ready, view, playback, download, editor, error, busy, visible, run, playbackFailed, openDonkey, openDownload } = useProjectApp();
  const project = view?.project;
  const preview = view?.preview;
  const rendering = preview?.status === "queued" || preview?.status === "running";
  const exp = view?.export;
  const exporting = exp?.status === "queued" || exp?.status === "running";
  // The editor is the card: its own chrome carries every control.
  if (editor && project) return <main className="editing">
    <iframe className="editor" src={editor.url} title={`Editing ${project.name}`} allow="fullscreen; clipboard-read; clipboard-write" />
  </main>;
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
      {exporting && <div role="status"><p>{exp.status === "queued" ? "Waiting to export…" : `Exporting ${exp.name ?? "video"}… ${Math.round(exp.progress * 100)}%`}</p><progress max={1} value={exp.progress} /></div>}
      {exp?.status === "done" && !download && <p className="muted">Export {exp.name ?? ""} finished. Renewing the download link…</p>}
      {(exp?.status === "error" || exp?.status === "expired") && <p role="alert">{exp.error ?? "The export did not finish."}</p>}
      {view.history?.undo && <p className="muted">Last step: {view.history.undo}</p>}
      <nav>
        {view.canRender && <button className="primary" disabled={busy || rendering || !ready} onClick={() => void run("render_preview", { projectId: project.id })}>Render preview</button>}
        {download && <button className="primary" disabled={!ready} onClick={() => openDownload()}>Download {download.name}</button>}
        {view.canEdit && <button disabled={busy || exporting || !ready} onClick={() => void run("export_video", { projectId: project.id })}>Export video</button>}
        {view.canEdit && view.history?.undo && <button disabled={busy || !ready} onClick={() => void run("undo", { projectId: project.id })}>Undo</button>}
        {view.canEdit && view.history?.redo && <button disabled={busy || !ready} onClick={() => void run("redo", { projectId: project.id })}>Redo</button>}
        <button disabled={!ready} onClick={() => openDonkey()}>Open in Donkey Cut ↗</button>
        <button disabled={busy || !ready} onClick={() => void run("list_projects", {})}>Projects</button>
        {error && <button disabled={busy || !ready} onClick={() => void run("open_project", { projectId: project.id })}>Try again</button>}
      </nav>
    </>}
  </main>;
}
