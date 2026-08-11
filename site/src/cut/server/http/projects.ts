import { execFile } from "node:child_process";
import { normalizeAspect, type ProjectDoc } from "@/cut/lib/types";
import { detectSilence, extractAudio, makeFreezeFrame, probeDims, probeDuration } from "../frames";
import {
  createProject,
  createProjectFolder,
  deleteExport,
  deleteMedia,
  deleteProject,
  deleteProjectFolder,
  duplicateProject,
  exportPath,
  listExports,
  listProjectFolders,
  listProjects,
  mediaPath,
  moveProjectToFolder,
  previewPath,
  readProject,
  renameProjectFolder,
  saveMedia,
  sweepOrphanMedia,
  writeProject,
} from "../projects";
import { serveFileRange } from "../serveFile";
import { importUrlToProject } from "../urlImport";
import { createTranscribeJob, getTranscribeJob, type TranscribeSpec } from "../transcribe";
import { exists } from "../util";

const err = (message: string, status: number) => Response.json({ error: message }, { status });
const caught = (e: unknown, fallback: string, status = 500) =>
  err(e instanceof Error ? e.message : fallback, status);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Project CRUD, media, exports, transcription, freeze-frames. */
export const projectsApi = {
  async list() {
    return Response.json(await listProjects());
  },

  async folders() {
    return Response.json(await listProjectFolders());
  },

  async createFolder(req: Request) {
    try {
      const { name } = (await req.json()) as { name?: string };
      return Response.json(await createProjectFolder(name ?? ""));
    } catch (e) {
      return caught(e, "Could not create folder.");
    }
  },

  async renameFolder(req: Request, { id }: { id: string }) {
    try {
      const { name } = (await req.json()) as { name?: string };
      return Response.json(await renameProjectFolder(id, name ?? ""));
    } catch (e) {
      return caught(e, "Could not rename folder.");
    }
  },

  async deleteFolder(_req: Request, { id }: { id: string }) {
    try {
      await deleteProjectFolder(id);
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete folder.");
    }
  },

  /** File a project under a folder (or `null` to ungroup). */
  async move(req: Request, { id }: { id: string }) {
    try {
      const { folderId } = (await req.json()) as { folderId: string | null };
      await moveProjectToFolder(id, folderId ?? null);
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not move project.");
    }
  },

  async create(req: Request) {
    try {
      const { name, folderId } = (await req.json()) as {
        name?: string;
        folderId?: string | null;
      };
      return Response.json(await createProject(name ?? "Untitled", folderId ?? null));
    } catch (e) {
      return caught(e, "Could not create project.");
    }
  },

  async get(_req: Request, { id }: { id: string }) {
    const doc = await readProject(id).catch(() => null);
    if (!doc) return err("Project not found.", 404);
    void sweepOrphanMedia(id, doc).catch(() => {});
    return Response.json(doc);
  },

  async put(req: Request, { id }: { id: string }) {
    try {
      const existing = await readProject(id);
      if (!existing) return err("Project not found.", 404);
      const body = (await req.json()) as Partial<ProjectDoc>;
      const doc: ProjectDoc = {
        ...existing,
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing.name,
        assets: Array.isArray(body.assets) ? body.assets : existing.assets,
        clips: Array.isArray(body.clips) ? body.clips : existing.clips,
        transitions: Array.isArray(body.transitions) ? body.transitions : existing.transitions,
        audioClips: Array.isArray(body.audioClips) ? body.audioClips : existing.audioClips,
        // Layer clips now live in `clips` (each with its `track`). A merged
        // client saves `clips` with no `overlayClips`, which clears the legacy
        // array so the two shapes can't drift or duplicate. A pre-merge client
        // still sends both — its `overlayClips` are real layer data, so they
        // persist untouched rather than being silently deleted.
        overlayClips: Array.isArray(body.overlayClips)
          ? body.overlayClips
          : Array.isArray(body.clips)
            ? []
            : existing.overlayClips,
        overlays: Array.isArray(body.overlays) ? body.overlays : existing.overlays,
        templates: Array.isArray(body.templates) ? body.templates : existing.templates,
        aspect: normalizeAspect(body.aspect) ?? existing.aspect,
        fadeIn: typeof body.fadeIn === "number" ? body.fadeIn : existing.fadeIn,
        fadeOut: typeof body.fadeOut === "number" ? body.fadeOut : existing.fadeOut,
        subtitles:
          body.subtitles && typeof body.subtitles === "object"
            ? body.subtitles
            : existing.subtitles,
        // Per-project view metadata (timeline zoom, …) — not part of the cut.
        ui:
          body.ui && typeof body.ui === "object" ? { ...existing.ui, ...body.ui } : existing.ui,
        publish:
          body.publish && typeof body.publish === "object"
            ? { ...existing.publish, ...body.publish }
            : existing.publish,
        notes:
          body.notes && typeof body.notes === "object"
            ? { ...existing.notes, ...body.notes }
            : existing.notes,
        // Brief-to-video run state. Persisted verbatim; a client that omits the
        // key keeps the existing plan, and null clears it (a dismissed plan) —
        // normalized to undefined so the doc at rest never stores null.
        genvideo: body.genvideo !== undefined ? body.genvideo ?? undefined : existing.genvideo,
        renders: Array.isArray(body.renders) ? body.renders : existing.renders,
      };
      await writeProject(id, doc);
      return Response.json({ ok: true, updatedAt: doc.updatedAt });
    } catch (e) {
      return caught(e, "Could not save project.");
    }
  },

  async remove(_req: Request, { id }: { id: string }) {
    try {
      await deleteProject(id);
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete project.");
    }
  },

  /** Duplicate a project (doc + media) into a fresh one. */
  async duplicate(_req: Request, { id }: { id: string }) {
    try {
      return Response.json(await duplicateProject(id));
    } catch (e) {
      return caught(e, "Could not duplicate project.");
    }
  },

  /** The low-res proxy of the edit, played on the project card's hover. */
  async servePreview(req: Request, { id }: { id: string }) {
    let p: string;
    try {
      p = previewPath(id);
    } catch {
      return new Response("Bad request.", { status: 400 });
    }
    return serveFileRange(p, req, { contentType: "video/mp4" });
  },

  /** Download a media URL straight into the project's media folder. */
  async importUrl(req: Request, { id }: { id: string }) {
    try {
      const { url } = (await req.json()) as { url?: string };
      if (!url) return err("No URL provided.", 400);
      return Response.json(await importUrlToProject(id, url));
    } catch (e) {
      return caught(e, "Could not import that URL.");
    }
  },

  async uploadMedia(req: Request, { id }: { id: string }) {
    try {
      if (!(await readProject(id))) return err("Project not found.", 404);
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return err("No file in upload.", 400);
      const fileName = await saveMedia(id, file);
      return Response.json({ fileName });
    } catch (e) {
      return caught(e, "Upload failed.");
    }
  },

  /** Delete a media file — called when its last referencing asset is removed. */
  async removeMedia(_req: Request, { id, file }: { id: string; file: string }) {
    try {
      await deleteMedia(id, decodeURIComponent(file));
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete the media file.");
    }
  },

  /** Reveal a media file in Finder (Cut runs on the user's own Mac). */
  async revealMedia(_req: Request, { id, file }: { id: string; file: string }) {
    let p: string;
    try {
      p = mediaPath(id, decodeURIComponent(file));
    } catch {
      return err("Bad request.", 400);
    }
    if (!(await exists(p))) return err("Media file not found.", 404);
    try {
      await new Promise<void>((resolve, reject) =>
        execFile("open", ["-R", p], (e) => (e ? reject(e) : resolve()))
      );
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not reveal the file.");
    }
  },

  /** Raw media file with Range support so <video>/<audio> can seek. */
  async serveMedia(req: Request, { id, file }: { id: string; file: string }) {
    let p: string;
    try {
      p = mediaPath(id, decodeURIComponent(file));
    } catch {
      return new Response("Bad request.", { status: 400 });
    }
    return serveFileRange(p, req);
  },

  /** Rendered exports for a project, newest first. */
  async listExports(_req: Request, { id }: { id: string }) {
    try {
      return Response.json(await listExports(id));
    } catch {
      return err("Invalid project.", 400);
    }
  },

  /** A rendered export with Range support so the preview player can seek. */
  async serveExport(req: Request, { id, file }: { id: string; file: string }) {
    let p: string;
    try {
      p = exportPath(id, decodeURIComponent(file));
    } catch {
      return new Response("Bad request.", { status: 400 });
    }
    return serveFileRange(p, req, { contentType: "video/mp4" });
  },

  /** Reveal a rendered export in Finder (Cut runs on the user's own Mac). */
  async revealExport(_req: Request, { id, file }: { id: string; file: string }) {
    let p: string;
    try {
      p = exportPath(id, decodeURIComponent(file));
    } catch {
      return err("Bad request.", 400);
    }
    if (!(await exists(p))) return err("Export not found.", 404);
    try {
      await new Promise<void>((resolve, reject) =>
        execFile("open", ["-R", p], (e) => (e ? reject(e) : resolve()))
      );
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not reveal the file.");
    }
  },

  /** Delete a rendered export from the project folder. */
  async removeExport(_req: Request, { id, file }: { id: string; file: string }) {
    try {
      await deleteExport(id, decodeURIComponent(file));
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not delete the export.");
    }
  },

  /** Start a background transcription of the current cut. */
  async transcribeStart(req: Request, { id }: { id: string }) {
    try {
      const body = (await req.json()) as Omit<TranscribeSpec, "projectId">;
      if (
        !Array.isArray(body.clips) ||
        !Array.isArray(body.audio) ||
        typeof body.duration !== "number"
      ) {
        return err("Bad transcribe spec.", 400);
      }
      const job = await createTranscribeJob({ ...body, projectId: id });
      return Response.json({ id: job.id });
    } catch (e) {
      return caught(e, String(e));
    }
  },

  /** Poll a transcription job: ?job=<id> */
  async transcribePoll(req: Request, { id }: { id: string }) {
    const jobId = new URL(req.url).searchParams.get("job");
    const job = jobId ? getTranscribeJob(jobId) : undefined;
    if (!job || job.projectId !== id) return err("Unknown transcription job.", 404);
    return Response.json({
      status: job.status,
      stage: job.stage,
      error: job.error,
      cues: job.status === "done" ? job.cues : undefined,
    });
  },

  /** Store an uploaded image as a first-class image asset at native
   * resolution — no video baking. AI generations and stock tiles land here. */
  async importImage(req: Request, { id }: { id: string }) {
    try {
      if (!(await readProject(id))) return err("Project not found.", 404);
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return err("No image in upload.", 400);
      const nameField = form.get("name");
      const name = typeof nameField === "string" && nameField.trim() ? nameField.trim() : file.name;
      const raw = form.get("origin");
      const origin = raw === "generated" || raw === "sticker" ? raw : undefined;
      const fileName = await saveMedia(id, file);
      const dims = await probeDims(mediaPath(id, fileName));
      return Response.json({
        id: crypto.randomUUID().slice(0, 8),
        type: "image",
        name,
        fileName,
        duration: 0,
        width: dims.width,
        height: dims.height,
        ...(origin ? { origin } : {}),
      });
    } catch (e) {
      return caught(e, "Could not import the image.");
    }
  },

  /** Render a freeze-frame still clip from a media file's frame. */
  async freeze(req: Request, { id }: { id: string }) {
    try {
      if (!(await readProject(id))) return err("Project not found.", 404);
      const body = (await req.json()) as {
        file?: string;
        srcTime?: number;
        duration?: number;
        frame?: { w?: number; h?: number };
        framing?: { fit?: "fit" | "fill"; panX?: number; panY?: number };
      };
      if (!body.file || typeof body.srcTime !== "number") {
        return err("file and srcTime are required.", 400);
      }
      const frame =
        typeof body.frame?.w === "number" && typeof body.frame?.h === "number"
          ? { w: Math.round(body.frame.w), h: Math.round(body.frame.h) }
          : undefined;
      const framing = frame
        ? {
            fit: body.framing?.fit === "fill" ? ("fill" as const) : ("fit" as const),
            panX: typeof body.framing?.panX === "number" ? body.framing.panX : 0,
            panY: typeof body.framing?.panY === "number" ? body.framing.panY : 0,
          }
        : undefined;
      const made = await makeFreezeFrame(id, body.file, body.srcTime, body.duration ?? 1, frame, framing);
      return Response.json({
        id: crypto.randomUUID().slice(0, 8),
        fileName: made.fileName,
        name: made.fileName,
        type: "video",
        duration: made.duration,
        width: made.width,
        height: made.height,
      });
    } catch (e) {
      return caught(e, String(e));
    }
  },

  /** Report silent stretches in a media file's audio. */
  async silence(req: Request, { id }: { id: string }) {
    try {
      if (!(await readProject(id))) return err("Project not found.", 404);
      const body = (await req.json()) as {
        file?: string;
        from?: number;
        to?: number;
        threshold_db?: number;
        min_silence?: number;
      };
      if (!body.file) return err("file is required.", 400);
      const from = Math.max(0, typeof body.from === "number" ? body.from : 0);
      const to = typeof body.to === "number" ? body.to : await probeDuration(mediaPath(id, body.file));
      if (typeof body.to !== "number" && to <= 0)
        return err("Could not read the media duration — pass to (seconds).", 400);
      if (!(to > from)) return err("from/to describe an empty range.", 400);
      const thresholdDb = clamp(typeof body.threshold_db === "number" ? body.threshold_db : -30, -90, 0);
      const minSilence = clamp(typeof body.min_silence === "number" ? body.min_silence : 0.35, 0.05, 10);
      const silences = await detectSilence(id, body.file, { from, to, thresholdDb, minSilence });
      return Response.json({ silences, from, to });
    } catch (e) {
      return caught(e, "Could not scan for silence.");
    }
  },

  /** Extract a media file's audio track so the assistant can hear it (video and
   * audio alike). Returns raw AAC bytes; the caller inlines them for the model. */
  async audio(req: Request, { id }: { id: string }) {
    try {
      if (!(await readProject(id))) return err("Project not found.", 404);
      const body = (await req.json()) as { file?: string; from?: number; to?: number };
      if (!body.file) return err("file is required.", 400);
      const from = Math.max(0, typeof body.from === "number" ? body.from : 0);
      const to = typeof body.to === "number" ? body.to : undefined;
      if (to !== undefined && !(to > from)) return err("from/to describe an empty range.", 400);
      const audio = await extractAudio(id, body.file, { from, to });
      return new Response(new Uint8Array(audio), {
        headers: { "Content-Type": "audio/aac", "Content-Length": String(audio.length) },
      });
    } catch (e) {
      return caught(e, "Could not read the audio.");
    }
  },
};
