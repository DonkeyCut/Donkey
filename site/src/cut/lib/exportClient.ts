"use client";

import { apiFetch, apiJson, getBackend, type CutBackend } from "./backend";
import { quotaErrorMessage } from "./backend/cloud";
import { normalizeGrade } from "./colorGrade";
import { putSigned } from "./media";
import { clipSpeed, getClipSpans, overlayLayers, projectDuration, spanSequence, useEditor } from "./store";
import { captionStyle, cueOverlay, cueWordWindows, laneCues, subtitleLaneCount, trackPos } from "./subtitles";
import { renderOverlayPng } from "./textRender";
import { frameOf, overlayAnimStyle } from "./types";
import type {
  Aspect,
  AudioClip,
  ClipAnim,
  MediaAsset,
  SubtitlesBlock,
  TextOverlay,
  VideoClip,
} from "./types";

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
}

/** Presets pick a short-side target; `presetSettings` derives both dims from
 * the project ratio. */
export const EXPORT_PRESETS = [
  {
    id: "tiktok",
    label: "Best · 1080p",
    detail: "H.264 · best quality",
    shortSide: 1080,
    settings: { fps: 30, crf: 19, preset: "medium" },
  },
  {
    id: "fast",
    label: "Quick share · 1080p",
    detail: "smaller file, faster",
    shortSide: 1080,
    settings: { fps: 30, crf: 24, preset: "veryfast" },
  },
  {
    id: "light",
    label: "Draft · 720p",
    detail: "fastest render",
    shortSide: 720,
    settings: { fps: 30, crf: 24, preset: "veryfast" },
  },
] as const;

/** Frame dims for an aspect scaled to a short-side target, even-rounded. */
function scaledFrame(aspect: Aspect, shortSide: number): { width: number; height: number } {
  const f = frameOf(aspect);
  const k = shortSide / Math.min(f.w, f.h);
  const even = (n: number) => 2 * Math.round((n * k) / 2);
  return { width: even(f.w), height: even(f.h) };
}

export function presetSettings(
  preset: (typeof EXPORT_PRESETS)[number],
  aspect: Aspect
): ExportSettings {
  return { ...scaledFrame(aspect, preset.shortSide), ...preset.settings };
}

/**
 * "Original": the highest resolution the timeline's own footage justifies,
 * along the project aspect. It scales the 1080p base by the sharpest source
 * clip — never below the base (so it is always the highest option), never
 * above 4K, and never upscaled past the source. Unknown source sizes fall
 * back to the base.
 */
export function originalSettings(
  aspect: Aspect,
  clips: VideoClip[],
  assets: MediaAsset[]
): ExportSettings {
  const base = frameOf(aspect);
  const longBase = Math.max(base.w, base.h);
  const srcLong = Math.max(
    0,
    ...getClipSpans(clips, assets).map((sp) =>
      Math.max(sp.asset.width ?? 0, sp.asset.height ?? 0)
    )
  );
  // The 4K long-side cap wins over the 1080 base floor: a very wide custom
  // ratio (whose base already exceeds 3840) scales down to stay encodable.
  const k = Math.min(
    3840 / longBase,
    Math.min(2, Math.max(1, srcLong / longBase || 1))
  );
  const even = (n: number) => 2 * Math.round((n * k) / 2);
  return { width: even(base.w), height: even(base.h), fps: 30, crf: 19, preset: "medium" };
}

/**
 * Rough output size for a preset, in bytes. The encoder is CRF (variable
 * bitrate), so this is a heuristic: it models H.264 bits-per-pixel as halving
 * every +6 CRF from a ~0.08 bpp anchor at CRF 23, scaled by frame area and fps,
 * plus the fixed 192 kbps AAC audio. Busy footage runs larger and flat footage
 * smaller, so the dialog shows it as an approximation, not a promise.
 */
export function estimateExportBytes(settings: ExportSettings, durationSec: number): number {
  if (durationSec <= 0) return 0;
  const pixelsPerSec = settings.width * settings.height * settings.fps;
  const bpp = 0.08 * 2 ** ((23 - settings.crf) / 6);
  const videoBps = pixelsPerSec * bpp;
  const audioBps = 192_000;
  return ((videoBps + audioBps) * durationSec) / 8;
}

/** Human-readable size estimate matching the finished-export MB display. */
export function formatSizeEstimate(bytes: number): string {
  if (bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return "~1 MB";
  if (mb < 1000) return `~${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `~${(mb / 1024).toFixed(1)} GB`;
}

/** Reveal a rendered export in Finder (local engine only). */
export async function revealExport(
  projectId: string,
  file: string,
  backend: CutBackend = getBackend()
) {
  await backend.fetch(
    `/api/cut/projects/${projectId}/exports/${encodeURIComponent(file)}/reveal`,
    { method: "POST" }
  );
}

/** Download a rendered export by file name — what stands in for revealExport
 * when the backend has no Finder (the cloud route 302s to a signed R2 URL with
 * attachment disposition). */
export function downloadProjectExport(projectId: string, file: string) {
  const a = document.createElement("a");
  a.href = getBackend().url(
    `/api/cut/projects/${projectId}/exports/${encodeURIComponent(file)}?download=1`
  );
  a.download = file;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Delete a rendered export from the project folder. Throws on failure so the
 * UI can stay truthful instead of optimistically dropping a file that's still
 * on disk (which is why deleted exports used to reappear on the next refresh). */
export async function deleteExport(projectId: string, file: string) {
  const res = await apiFetch(
    `/api/cut/projects/${projectId}/exports/${encodeURIComponent(file)}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not delete the export.");
  }
}

export interface ExportDoc {
  /** Output frame ratio the cut renders at — keeps burn-in layout (caption
   * wrap) in the same design space as the live preview. */
  aspect: Aspect;
  assets: MediaAsset[];
  /** Every video clip, any track (track 0 folds sequentially, others composite). */
  clips: VideoClip[];
  audioClips: AudioClip[];
  overlays: TextOverlay[];
  subtitles: SubtitlesBlock;
  /** Whole-video fades (seconds): in from black / out to black on the final
   * composite. */
  fadeIn?: number;
  fadeOut?: number;
}


/** The neutral built cut: the engine spec plus the browser-rendered overlay
 * PNGs. The local path serializes it to the engine's multipart form; the
 * cloud path presigns the PNGs to R2 and posts the spec as JSON. */
interface ExportPayload {
  spec: object;
  pngs: { name: string; blob: Blob }[];
}

/** Build the export spec + overlay PNGs from the cut. Media already lives in
 * the project folder — the spec references it by file name; only overlay PNGs
 * travel with the request. Shared by full exports and the low-res hover proxy. */
async function buildExportPayload(
  projectId: string,
  doc: ExportDoc,
  settings: ExportSettings,
  target: "export" | "preview" | "card"
): Promise<ExportPayload> {
  const spans = getClipSpans(doc.clips, doc.assets);
  const duration = projectDuration(doc);
  const pngs: ExportPayload["pngs"] = [];
  const assetById = new Map(doc.assets.map((a) => [a.id, a]));
  // Overlay-only cuts (empty track 0) still export: track 0 becomes a black bed
  // the length of the project and the overlays/soundtrack composite onto it —
  // the same path as a gap before the first track-0 clip. Refuse only a cut with
  // no renderable content at all.
  const hasOverlayVideo = overlayLayers(doc.clips).some(
    (c) => !c.hidden && assetById.has(c.assetId) && c.start < duration,
  );
  const hasAudio = doc.audioClips.some(
    (a) => !a.hidden && a.start < duration && assetById.has(a.assetId),
  );
  if (spans.length === 0 && !hasOverlayVideo && !hasAudio) {
    throw new Error("Add a video to the timeline first.");
  }

  const clipEntries = spans.map((sp) => ({
    file: sp.asset.fileName,
    in: sp.clip.in,
    out: sp.clip.out,
    muted: sp.clip.muted,
    volume: sp.clip.volume ?? 1,
    fit: sp.clip.fit ?? "fit",
    panX: sp.clip.panX ?? 0,
    panY: sp.clip.panY ?? 0,
    frame: sp.clip.frame,
    speed: clipSpeed(sp.clip),
    transition: sp.transitionOut,
    // The style rides along with the overlap; the server resolves it to an
    // xfade name (and the cross-zoom ramps) itself, so the spec carries only
    // the id.
    transitionStyle: sp.clip.transitionStyle,
    animIn: sp.clip.animIn,
    animOut: sp.clip.animOut,
    look: sp.clip.look,
    lookAmount: sp.clip.lookAmount,
    hidden: sp.clip.hidden,
    // A still: the server loops the image for the clip's length instead of
    // trimming a source span.
    image: sp.asset.type === "image",
    grade: normalizeGrade(sp.clip.grade),
  }));

  // The server's video graph is a sequential fold, so gaps between the
  // free-placed clips ship as explicit spacer segments: no file, hidden and
  // muted, which the server renders as black + silence for the gap's length.
  const spacer = (len: number) => ({
    file: "",
    in: 0,
    out: len,
    muted: true,
    volume: 0,
    fit: "fit" as const,
    panX: 0,
    panY: 0,
    frame: undefined,
    speed: 1,
    transition: 0,
    hidden: true,
    image: false,
  });
  // An overlay-only cut has no track-0 spans: the whole base is one black bed.
  const clips =
    spans.length === 0
      ? [spacer(duration)]
      : spanSequence(spans).flatMap(({ gapBefore }, i) => [
          ...(gapBefore > 0 ? [spacer(gapBefore)] : []),
          clipEntries[i],
        ]);

  // Video tracks composited over track 0; hidden ones are dropped. Each
  // track's transitions and animations translate into per-clip head/tail
  // ramps: on an upper track a fade is an alpha fade (transparent, so the
  // tracks beneath show through), and a transition blends the incoming clip
  // in over the outgoing one — the incoming alpha-fades in for the overlap
  // while the outgoing stays opaque underneath it (cross zoom adds its zoom
  // ramps). Animations map fade/zoom natively; the styles that need frame
  // motion degrade to a fade up here.
  const overlayTracks = [...new Set(overlayLayers(doc.clips).map((c) => c.track))];
  const overlayVideos = overlayTracks.flatMap((track) => {
    const trackSpans = getClipSpans(doc.clips, doc.assets, track);
    const ramps = trackSpans.map(() => ({ headFade: 0, tailFade: 0, headZoom: 0, tailZoom: 0 }));
    trackSpans.forEach((sp, i) => {
      const r = ramps[i];
      const applyAnim = (a: ClipAnim | undefined, side: "head" | "tail") => {
        if (!a) return;
        const secs = Math.min(a.seconds, sp.len);
        if (overlayAnimStyle(a.style) === "zoom") {
          r[side === "head" ? "headZoom" : "tailZoom"] = secs;
        } else {
          r[side === "head" ? "headFade" : "tailFade"] = secs;
        }
      };
      // A transitioned joint owns its edges: that side's animation is held so
      // it never fights the transition's blend (mirrors preview and track 0).
      if (!((trackSpans[i - 1]?.transitionOut ?? 0) > 0)) applyAnim(sp.clip.animIn, "head");
      if (!(sp.transitionOut > 0)) applyAnim(sp.clip.animOut, "tail");
      if (sp.transitionOut > 0 && trackSpans[i + 1]) {
        const nr = ramps[i + 1];
        nr.headFade = Math.max(nr.headFade, sp.transitionOut);
        if ((sp.clip.transitionStyle ?? "crossfade") === "crosszoom") {
          r.tailZoom = Math.max(r.tailZoom, sp.transitionOut);
          nr.headZoom = Math.max(nr.headZoom, sp.transitionOut);
        }
      }
    });
    return trackSpans
      .map((sp, i) => ({ c: sp.clip, ramp: ramps[i] }))
      .filter(({ c }) => !c.hidden && c.start < duration)
      .map(({ c, ramp }) => ({
        file: assetById.get(c.assetId)!.fileName,
        in: c.in,
        out: c.out,
        start: c.start,
        track: c.track,
        frame: c.frame,
        // Pass `fit` through unset so the server's "default full-frame overlay
        // covers what's below" branch fires — normalizing to "fit" defeated it.
        fit: c.fit,
        muted: c.muted,
        volume: c.volume,
        speed: c.speed,
        image: assetById.get(c.assetId)!.type === "image",
        grade: normalizeGrade(c.grade),
        look: c.look,
        lookAmount: c.lookAmount,
        ...ramp,
      }));
  });

  const audio = doc.audioClips
    .filter((a) => !a.hidden && a.start < duration && assetById.has(a.assetId))
    .map((a) => ({
      file: assetById.get(a.assetId)!.fileName,
      in: a.in,
      out: a.out,
      start: a.start,
      volume: a.volume,
      fadeIn: a.fadeIn ?? 0,
      fadeOut: a.fadeOut ?? 0,
      speed: a.speed,
      duck: a.duck,
    }));

  const overlays: { file: string; start: number; end: number }[] = [];
  for (let i = 0; i < doc.overlays.length; i++) {
    const o = doc.overlays[i];
    if (o.start >= duration || !o.text.trim()) continue;
    const png = await renderOverlayPng(o, settings.width, settings.height);
    const key = `overlay_${i}.png`;
    pngs.push({ name: key, blob: png });
    overlays.push({ file: key, start: o.start, end: Math.min(o.end, duration) });
  }

  // Subtitle stills travel in their own spec lane: the server plays each
  // subtitle track as one concat-demuxer slideshow (with a transparent filler
  // frame for gaps), so karaoke word windows don't each become an ffmpeg
  // input. Tracks overlap each other in time, so every track (language) gets
  // its own slideshow, marked by `lane`.
  const captions: { file: string; start: number; end: number; lane?: number }[] = [];
  if (doc.subtitles.showOnVideo) {
    const capStyle = captionStyle(doc.subtitles.style);
    for (let lane = 0; lane < subtitleLaneCount(doc.subtitles); lane++) {
      const cues = laneCues(doc.subtitles, lane);
      const pos = trackPos(doc.subtitles, capStyle, lane);
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        if (cue.start >= duration || !cue.text.trim()) continue;
        // Karaoke burns one frame per word window (the spoken word accented);
        // otherwise the whole cue is a single still.
        const windows = doc.subtitles.wordHighlight
          ? cueWordWindows(cue)
          : [{ start: cue.start, end: cue.end }];
        for (let wi = 0; wi < windows.length; wi++) {
          const win = windows[wi];
          if (win.start >= duration) break;
          const png = await renderOverlayPng(
            cueOverlay(
              cue,
              capStyle,
              i === 0,
              pos,
              doc.subtitles.wordHighlight ? wi : undefined,
              // Wrap in design space (1080 short side) from the project ratio —
              // the same width the preview passes, whatever the render size.
              frameOf(doc.aspect).w
            ),
            settings.width,
            settings.height
          );
          const key = windows.length > 1 ? `sub_${lane}_${i}_${wi}.png` : `sub_${lane}_${i}.png`;
          pngs.push({ name: key, blob: png });
          captions.push({
            file: key,
            start: win.start,
            end: Math.min(win.end, duration),
            ...(lane > 0 ? { lane } : {}),
          });
        }
      }
    }
    if (captions.length > 0) {
      const blank = document.createElement("canvas");
      blank.width = settings.width;
      blank.height = settings.height;
      const png = await new Promise<Blob>((resolve, reject) =>
        blank.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not render captions."))), "image/png")
      );
      pngs.push({ name: "sub_blank.png", blob: png });
    }
  }

  return {
    spec: {
      projectId,
      target,
      ...settings,
      duration,
      fadeIn: doc.fadeIn ?? 0,
      fadeOut: doc.fadeOut ?? 0,
      clips,
      audio,
      overlayVideos,
      overlays,
      captions,
    },
    pngs,
  };
}

/** Serialize a payload to the engine's multipart form: PNGs in render order,
 * then the spec — the exact request shape from before the payload split. */
function exportFormFromPayload({ spec, pngs }: ExportPayload): FormData {
  const form = new FormData();
  for (const p of pngs) form.append(p.name, p.blob, p.name);
  form.append("spec", JSON.stringify(spec));
  return form;
}

/** Kick off an export on the given backend, returning the create response.
 * The backend is captured when the export starts, so a job keeps rendering
 * against its own backend even after the app rebinds to the other residency.
 * Local: the engine's multipart form. Cloud: presign the overlay PNGs, PUT
 * them straight to R2, then POST the JSON export body. */
async function postExport(
  projectId: string,
  payload: ExportPayload,
  outName: string,
  backend: CutBackend
): Promise<Response> {
  if (backend.kind !== "cloud") {
    return backend.fetch("/api/cut/export", { method: "POST", body: exportFormFromPayload(payload) });
  }
  const overlays: { name: string; key: string }[] = [];
  if (payload.pngs.length > 0) {
    const pre = await backend.fetch("/api/cut/export/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: payload.pngs.map((p) => ({ name: p.name, bytes: p.blob.size })),
      }),
    });
    const preBody = await apiJson<{ files?: { name: string; key: string; url: string }[] }>(pre);
    if (!pre.ok || !preBody.files) {
      throw new Error(
        quotaErrorMessage(pre.status, preBody) ?? preBody.error ?? "Export failed to start."
      );
    }
    const byName = new Map(preBody.files.map((f) => [f.name, f]));
    await Promise.all(
      payload.pngs.map(async (p) => {
        const target = byName.get(p.name);
        if (!target) throw new Error("Export failed to start.");
        await putSigned(target.url, p.blob, "image/png");
      })
    );
    for (const p of payload.pngs) overlays.push({ name: p.name, key: byName.get(p.name)!.key });
  }
  return backend.fetch("/api/cut/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec: payload.spec, overlays, projectId, outName }),
  });
}

/** The cloud names the output client-side (the engine derives it from the
 * project name itself, deduping on disk); mirror the engine's sanitize rule. */
function exportOutName(): string {
  const base =
    useEditor.getState().projectName.replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 60) || "export";
  return `${base}.mp4`;
}

/** Poll an export job to completion, reporting progress. Returns the file name. */
export async function pollExport(
  jobId: string,
  onProgress: (stage: string, ratio: number) => void,
  isCanceled: () => boolean = () => false,
  backend: CutBackend = getBackend()
): Promise<string> {
  for (;;) {
    if (isCanceled()) throw new Error("Export canceled.");
    await new Promise((r) => setTimeout(r, 400));
    const st = await backend.fetch(`/api/cut/export/${jobId}`);
    const status = await apiJson<{
      status?: string;
      progress?: number;
      outName?: string;
    }>(st);
    if (!st.ok || status.status === "error") throw new Error(status.error ?? "Export failed.");
    onProgress("Rendering", status.progress ?? 0);
    if (status.status === "done") return status.outName ?? "export.mp4";
  }
}

/** Trigger a browser download of a finished export by job id. */
export function downloadExport(jobId: string, outName: string, backend: CutBackend = getBackend()) {
  const a = document.createElement("a");
  a.href = backend.url(`/api/cut/export/${jobId}/file`);
  a.download = outName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Build the cut and hand it to the engine, returning the new job id. Progress,
 * cancel, download, and the finished-file actions are all driven from the
 * engine's job feed by the exports dock — this only kicks the render off, so it
 * returns the moment the job is queued and never blocks on the encode. */
export async function createExportJob(
  projectId: string,
  doc: ExportDoc,
  settings: ExportSettings
): Promise<string> {
  const backend = getBackend(); // pinned: the payload build takes a while
  const payload = await buildExportPayload(projectId, doc, settings, "export");
  const res = await postExport(projectId, payload, exportOutName(), backend);
  const body = await apiJson<{ id?: string }>(res);
  if (!res.ok || !body.id) {
    // A quota rejection raises the upgrade wall on its way through, the same as
    // one from an upload — otherwise the only sign is a terse line in the dock.
    throw new Error(
      quotaErrorMessage(res.status, body) ?? body.error ?? "Export failed to start."
    );
  }
  return body.id;
}

/** Cancel a running or queued export job, or retire a settled one from the
 * export-jobs feed. */
export function cancelExportJob(jobId: string, backend: CutBackend = getBackend()) {
  void backend.fetch(`/api/cut/export/${jobId}`, { method: "DELETE" }).catch(() => {});
}

/** Low-res proxy of the actual edit for the project card's hover preview.
 * Renders through the same pipeline (overlays and all), writing the project's
 * preview.mp4. Best-effort: silently no-ops if a slot is busy or there's no
 * footage yet. */
export async function renderPreviewProxy(projectId: string, doc: ExportDoc) {
  const backend = getBackend(); // pinned: the proxy render outlives navigation
  const settings: ExportSettings = { ...scaledFrame(doc.aspect, 360), fps: 24, crf: 30, preset: "veryfast" };
  let res: Response;
  try {
    const payload = await buildExportPayload(projectId, doc, settings, "preview");
    res = await postExport(projectId, payload, "preview.mp4", backend);
  } catch {
    return; // no clips yet
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  if (!res.ok || !body.id) return; // a slot was busy; try again later
  await pollExport(body.id, () => {}, undefined, backend).catch(() => {});
}

/** Seconds of the cut a share card shows. */
const CARD_SECONDS = 5;

/** The cut's first `seconds`, as a doc. Clips keep their trim-in and lose
 * whatever hangs past the cut-off; everything starting after it drops. Used
 * for the share card, which is a five-second window onto the opening rather
 * than a render of the whole project. */
export function docFirstSeconds(doc: ExportDoc, seconds: number): ExportDoc {
  // A clip's timeline footprint is (out - in) / speed, so the trim that ends
  // it at `seconds` scales back through the speed.
  const clampOut = <T extends { start: number; in: number; out: number; speed?: number }>(
    clip: T
  ): T => {
    const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const room = (seconds - clip.start) * speed;
    return clip.out - clip.in <= room ? clip : { ...clip, out: clip.in + room };
  };
  const starts = <T extends { start: number }>(item: T) => item.start < seconds;
  return {
    ...doc,
    clips: doc.clips.filter(starts).map(clampOut),
    audioClips: doc.audioClips.filter(starts).map(clampOut),
    overlays: doc.overlays
      .filter(starts)
      .map((o) => (o.end <= seconds ? o : { ...o, end: seconds })),
    subtitles: {
      ...doc.subtitles,
      cues: doc.subtitles.cues
        .filter(starts)
        .map((c) => (c.end <= seconds ? c : { ...c, end: seconds })),
    },
    // A fade-out belongs to the end of the project, which the card cuts away.
    fadeOut: 0,
  };
}

/** Card frame size for an aspect: 16:9 sits close to the 1.91:1 social cards
 * want, and portrait cuts get a tall card rather than a letterboxed wide one. */
function cardSettings(aspect: Aspect): ExportSettings {
  return { ...scaledFrame(aspect, 720), fps: 15, crf: 26, preset: "veryfast" };
}

/** Render the project's link-preview card: the opening five seconds, which
 * the worker turns into the still frame and the animated thumbnail a shared
 * link unfurls with. Only shared projects have one, so this asks first and
 * costs a single small request when the project isn't shared.
 *
 * Best-effort throughout — a project with no footage, an unconfigured
 * backend, or a busy render slot simply keeps the card it already had. */
async function renderShareCard(projectId: string, doc: ExportDoc): Promise<void> {
  const backend = getBackend(); // pinned: the card render outlives navigation
  if (backend.kind !== "cloud") return;
  try {
    const res = await backend.fetch(`/api/cut/projects/${projectId}/share`);
    const body = (await res.json().catch(() => ({}))) as { share?: unknown | null };
    if (!res.ok || !body.share) return;
  } catch {
    return;
  }
  let res: Response;
  try {
    const payload = await buildExportPayload(
      projectId,
      docFirstSeconds(doc, CARD_SECONDS),
      cardSettings(doc.aspect),
      "card"
    );
    res = await postExport(projectId, payload, "card.mp4", backend);
  } catch {
    return; // no clips yet
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  if (!res.ok || !body.id) return;
  await pollExport(body.id, () => {}, undefined, backend).catch(() => {});
}

/** Rebuild the open project's share card from the cut as it stands. Fire and
 * forget: the card is an accessory to the link, and a failed render leaves the
 * previous one (or the generated placeholder) in place. */
export function refreshShareCard(projectId: string): void {
  const s = useEditor.getState();
  if (!s.loaded || s.projectId !== projectId || s.clips.length === 0) return;
  void renderShareCard(projectId, {
    aspect: s.aspect,
    assets: s.assets,
    clips: s.clips,
    audioClips: s.audioClips,
    overlays: s.overlays,
    subtitles: s.subtitles,
    fadeIn: s.fadeIn,
    fadeOut: s.fadeOut,
  }).catch(() => {});
}
