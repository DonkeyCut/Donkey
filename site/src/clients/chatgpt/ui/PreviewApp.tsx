import { ArtifactVideo } from "@donkeycut/artifact-player/ArtifactVideo";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl";
import { useProjectApp, type FramePage, type HostEdges, type HostTheme } from "./useProjectApp";
import "./preview.css";

export function PreviewApp() {
  const { ready, view, playback, editor, fullscreen, hostInset, edges, theme, error, busy, visible, run, playbackFailed, openDonkey, openFromFrame, saveFromFrame, requestFullscreen, retryEditor, createProject, framePage } = useProjectApp();
  const project = view?.project;
  // An editable projects card is the projects home, framed like the editor.
  const home = view?.view === "projects" && view.canEdit;
  const preview = view?.preview;
  const rendering = preview?.status === "queued" || preview?.status === "running";
  // The frame whose editor has said it is on screen.
  const [shown, setShown] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const t = useTranslations("chatgpt.widget");
  const problem = error && t(`problems.${error.key}`, { name: error.name ?? "" });
  // The card is the whole surface, so a project that is gone has no projects
  // home to fall back to: it says so in the editor's space and a new project
  // opens there in its place.
  if (view?.view === "missing") {
    return <main className="editing" data-mode={fullscreen ? "fullscreen" : "inline"} style={edgePadding(edges)} aria-busy={busy}>
      <div className="waiting">
        <p role="status">{t("deleted")}</p>
        {problem && <p role="alert">{problem}</p>}
        <button className="primary" disabled={busy || !ready} onClick={createProject}>{t("createNewProject")}</button>
      </div>
    </main>;
  }
  // An editable project is the editor, and an editable projects card is the
  // projects home; their own chrome carries every control. The card holds the
  // editor's inline space from the first paint, so a card ChatGPT shows again
  // after a reload is the editor while it fetches a fresh link. A skeleton in
  // the page's shape covers the frame until the frame reports something to see.
  if (view ? (project && view.canEdit) || home : !error) {
    const loading = !editor || shown !== editor.url;
    return <main className="editing" data-mode={fullscreen ? "fullscreen" : "inline"} style={edgePadding(edges)} aria-busy={loading}>
      {editor && (project || home) && <EditorFrame key={editor.url} url={editor.url} label={project ? t("editing", { name: project.name }) : t("home")} inset={hostInset} theme={theme} fullscreen={fullscreen} onReady={() => setShown(editor.url)} onPage={framePage} onFullscreen={requestFullscreen} onOpen={openFromFrame} onSave={saveFromFrame} onDownloadError={setDownloadError} onReconnect={retryEditor} />}
      {downloadError && <div className="download-error"><p role="alert">{downloadError}</p><button onClick={() => setDownloadError(null)}>{t("dismiss")}</button></div>}
      {error && (project || home) && !editor
        ? <div className="waiting">
          <p role="alert">{problem}</p>
          <button disabled={busy || !ready} onClick={retryEditor}>{t("tryAgain")}</button>
        </div>
        : loading && (home ? <HomeSkeleton /> : <EditorSkeleton />)}
    </main>;
  }
  // A read-only connection has no projects home: the model opens a project
  // and the card plays its preview.
  return <main style={cardPadding(edges, hostInset)} aria-busy={busy}>
    {problem && <p role="alert" className="error">{problem}</p>}
    {!view && ready && <button onClick={() => void run("open_project", {})}>{t("tryAgain")}</button>}
    {view?.view === "projects" && <p role="status">{t("readOnlyHome")}</p>}
    {project && <>
      <h1>{project.name}</h1>
      {playback && <ArtifactVideo src={playback.url} format="file" active={visible} onError={playbackFailed} aria-label={t("previewOf", { name: project.name })} />}
      {rendering && <div role="status"><p>{preview.status === "queued" ? t("waitingToRender") : t("rendering", { percent: Math.round(preview.progress * 100) })}</p><progress max={1} value={preview.progress} /></div>}
      {!preview && <p>{t("renderToWatch")}</p>}
      {preview?.status === "expired" && <p>{t("expired")}</p>}
      {preview?.status === "error" && <p role="alert">{preview.error}</p>}
      {preview?.status === "done" && preview.revision !== project.revision && <p className="muted">{t("earlierEdit")}</p>}
      <nav>
        {view.canRender && <button className="primary" disabled={busy || rendering || !ready} onClick={() => void run("render_preview", { projectId: project.id })}>{t("renderPreview")}</button>}
        <button disabled={!ready} onClick={() => openDonkey()}>{t("openInDonkey")}</button>
        {error && <button disabled={busy || !ready} onClick={() => void run("open_project", { projectId: project.id })}>{t("tryAgain")}</button>}
      </nav>
    </>}
  </main>;
}

/** Keeps the editor out of the bands the host draws over. */
const edgePadding = (edges: HostEdges) => ({ paddingTop: edges.top, paddingRight: edges.right, paddingLeft: edges.left });

/** The preview card's own 20px margin inside those bands, with its last rows
 * scrolling clear of the host's composer. */
const CARD_GAP = 20;
const cardPadding = (edges: HostEdges, bottom: number) => ({
  paddingTop: CARD_GAP + edges.top,
  paddingRight: CARD_GAP + edges.right,
  paddingBottom: CARD_GAP + bottom,
  paddingLeft: CARD_GAP + edges.left,
});

/** The editor's shape in the host's theme while it loads: the top bar, the tab
 * rail, the preview and the timeline, drawn as the site's skeleton slabs. */
function EditorSkeleton() {
  const t = useTranslations("chatgpt.widget");
  return <div className="skeleton" role="status" aria-label={t("openingEditor")}>
    <div className="bar"><i className="slab" /><i className="slab" /><span /><i className="slab" /><i className="slab" /></div>
    <div className="rail">{[0, 1, 2, 3, 4].map((i) => <i key={i} className="slab" />)}</div>
    <div className="stage"><i className="slab" /></div>
    <div className="timeline">
      <div className="controls"><i className="slab" /><i className="slab" /><i className="slab" /></div>
      {[0, 1, 2].map((i) => <div key={i} className="track"><i className="slab" /><i className="slab" /></div>)}
    </div>
  </div>;
}

/** The projects home's shape while it loads: the card rail and a shelf of
 * project tiles. */
function HomeSkeleton() {
  const t = useTranslations("chatgpt.widget");
  return <div className="skeleton home" role="status" aria-label={t("openingHome")}>
    <div className="rail">{[0, 1, 2].map((i) => <i key={i} className="slab" />)}</div>
    <div className="tiles"><i className="slab head" />{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} className="slab" />)}</div>
  </div>;
}

/** The editor, or the projects home, framed. It learns the host's display mode, its theme and how
 * tall the bottom overlay is when it loads, whenever that changes, and whenever it
 * asks; it says when it has something on screen, and its own toolbar asks
 * for fullscreen, for a tab on donkeycut.com, and for the saves the sandbox
 * blocks inside the frame. */
function EditorFrame({ url, label, inset, theme, fullscreen, onReady, onPage, onFullscreen, onOpen, onSave, onDownloadError, onReconnect }: { url: string; label: string; inset: number; theme: HostTheme; fullscreen: boolean; onReady: () => void; onPage: (url: string, page: FramePage) => void; onFullscreen: () => void; onOpen: (url: string) => void; onSave: (text: string, name: string, mimeType: string) => void; onDownloadError: (message: string | null) => void; onReconnect: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const origin = new URL(url).origin;
  const tell = () => frame.current?.contentWindow?.postMessage({ type: "donkeycut:host", insetBottom: inset, theme, displayMode: fullscreen ? "fullscreen" : "inline" }, origin);
  useEffect(tell, [inset, theme, fullscreen, origin]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "donkeycut:host?") tell();
      if (event.data?.type === "donkeycut:ready") onReady();
      // The page the frame moved to on its own: a project, or null for home.
      if (event.data?.type === "donkeycut:page") {
        const { projectId, name: projectName } = event.data as { projectId?: unknown; name?: unknown };
        if (projectId === null || typeof projectId === "string") onPage(url, { projectId, name: typeof projectName === "string" ? projectName : null });
      }
      if (event.data?.type === "donkeycut:fullscreen") onFullscreen();
      if (event.data?.type === "donkeycut:reconnect") onReconnect();
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
  return <iframe ref={frame} className="editor" src={url} onLoad={tell} aria-label={label} allow="fullscreen; clipboard-read; clipboard-write" />;
}
