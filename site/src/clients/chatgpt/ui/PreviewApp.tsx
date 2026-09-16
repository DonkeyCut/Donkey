import { ArtifactVideo } from "@donkeycut/artifact-player/ArtifactVideo";
import { useProjectApp } from "./useProjectApp";
import "./preview.css";

export function PreviewApp() {
  const { ready, view, playback, error, busy, visible, run, playbackFailed, openDonkey } = useProjectApp();
  const project = view?.project;
  const preview = view?.preview;
  const rendering = preview?.status === "queued" || preview?.status === "running";
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
        <button disabled={!ready} onClick={() => void openDonkey()}>Open in Donkey Cut ↗</button>
        <button disabled={busy || !ready} onClick={() => void run("list_projects", {})}>Projects</button>
        {error && <button disabled={busy || !ready} onClick={() => void run("open_project", { projectId: project.id })}>Try again</button>}
      </nav>
    </>}
  </main>;
}
