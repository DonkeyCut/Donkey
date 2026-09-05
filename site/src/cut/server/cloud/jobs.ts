// Render-job rows for the cloud worker (site/src/cut/worker). These routes only
// manage CutRenderJob rows — the worker claims and executes them. Response
// shapes byte-match the engine's export routes (http/export.ts + server/jobs.ts).
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { cutLimitsFor, EXPORT_QUOTA_MARGIN, renderJobCheck } from "./limits";
import { wakeRenderWorker } from "./wake";
import { getProject } from "./projects";
import { MEDIA_REDIRECT_HEADERS, mediaObjectUrl } from "./mediaCdn";
import { del, head, overlayKey, overlayPrefix, presignPut, projectExportKey } from "./r2";
import { contentTypeFor } from "../serveFile";
import { containerOfName, deliveryContainer, specMediaFiles, type ExportContainer } from "../../lib/exportDelivery";
import { addUsage, quotaCheck, reservedBytes, usageBytes } from "./usage";
import { caught, err, redirect } from "./util";

/** How long finished jobs stay in the export-jobs feed — the engine's registry
 * keeps a bounded terminal backlog; the cloud keeps a day. */
const FEED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long a browser render may hold its reserved name before it is treated
 * as a tab that went away. Generous next to the ten-minute cut the client will
 * take on, because the wall-clock cost of a render depends on the machine. */
const CLIENT_RENDER_WINDOW_MS = 2 * 60 * 60 * 1000;

// The spec goes straight to ffmpeg, so these are the largest frame, rate, and
// length a render may ask for: a 4K cut at 60 fps, four hours long, is already
// far past anything the editor produces.
const MAX_RENDER_EDGE = 4096;
const MAX_RENDER_FPS = 60;
const MAX_RENDER_SECONDS = 4 * 60 * 60;
const MAX_RENDER_CLIPS = 2000;

// Overlay uploads are transient render inputs the quota never sees, so their
// size is bounded here instead: per file, per batch, and by count. A render
// carries one PNG per caption cue and one per frame of every animated
// element, so the count and the batch run to a long, busy cut.
const MAX_OVERLAY_FILES = 20_000;
// A render's inputs: overlay stills, and for a browser-resident project the
// cut's own media, which rides with the job because the worker has no other
// way to reach a file that lives in a tab. A source clip can be as large as
// any upload.
const MAX_OVERLAY_BYTES = 4 * 1024 ** 3;
const MAX_OVERLAY_BATCH_BYTES = 8 * 1024 ** 3;


// The largest download an import may land, holding for unlimited tiers too.
const IMPORT_MAX_BYTES = 2 * 1024 ** 3;

// A running job writes its row every second. One this quiet lost its worker.
const HEARTBEAT_QUIET_MS = 30_000;

type JobRow = {
  id: string;
  projectId: string | null;
  kind: string;
  state: string;
  progress: number;
  outputKey: string | null;
  outName: string | null;
  result: unknown;
  error: string | null;
  claimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Why a client-supplied render spec cannot run, or null when it can. */
function specRefusal(spec: Record<string, unknown>): string | null {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const inRange = (v: unknown, lo: number, hi: number) => n(v) >= lo && n(v) <= hi;
  if (!inRange(spec.width, 2, MAX_RENDER_EDGE) || !inRange(spec.height, 2, MAX_RENDER_EDGE))
    return "Render size is out of range.";
  if (!inRange(spec.fps, 1, MAX_RENDER_FPS)) return "Frame rate is out of range.";
  if (!(n(spec.duration) > 0) || n(spec.duration) > MAX_RENDER_SECONDS)
    return "Render length is out of range.";
  if (Array.isArray(spec.clips) && spec.clips.length > MAX_RENDER_CLIPS) return "Too many clips.";
  return null;
}

/** Whether a job's row needs the container started: it is waiting to be
 * claimed, or it is marked running and its heartbeat has gone quiet — a worker
 * that died mid-job, which the woken replacement sweeps back to queued. A
 * healthy running job needs nothing, and a browser render (running with no
 * claim) is never a worker's. */
function needsWorker(row: JobRow): boolean {
  if (row.state === "queued") return true;
  return (
    row.state === "running" &&
    row.claimedAt !== null &&
    Date.now() - row.updatedAt.getTime() > HEARTBEAT_QUIET_MS
  );
}

/** The most bytes an import may bring in: what is left of the account's
 * storage, under the hard ceiling. */
async function importByteCeiling(userId: string): Promise<number> {
  const limits = await cutLimitsFor(userId);
  if (limits.storageBytes === null) return IMPORT_MAX_BYTES;
  const [stored, reserved] = await Promise.all([usageBytes(userId), reservedBytes(userId)]);
  return Math.max(0, Math.min(IMPORT_MAX_BYTES, limits.storageBytes - stored - reserved));
}

/** Drop the file a browser render uploaded for a row that never registered
 * it: the bytes have no media row, so nothing else would ever find them. */
async function dropUnregisteredExport(userId: string, row: JobRow): Promise<void> {
  if (!row.projectId || !row.outName) return;
  const key = projectExportKey(userId, row.projectId, row.outName);
  const registered = await prisma.cutMediaObject.findUnique({
    where: { r2Key: key },
    select: { id: true },
  });
  if (!registered) await del([key]);
}

/** Engine job status ("queued" | "running" | "done" | "error") from a row's
 * state; a canceled row reads as the engine's canceled-export error. */
function engineStatus(row: JobRow): { status: string; error?: string } {
  if (row.state === "canceled") return { status: "error", error: row.error ?? "Export canceled." };
  return { status: row.state, error: row.error ?? undefined };
}

async function findJob(userId: string, id: string): Promise<JobRow | null> {
  return prisma.cutRenderJob.findFirst({ where: { id, userId } });
}

/** Engine-style export name: the base with the container's extension and a
 * " 2", " 3"… suffix when taken
 * by an existing export object or a job still in flight. The client derives the
 * base from the project name; the dedupe happens here, where the rows are. */
async function exportName(
  userId: string,
  projectId: string,
  baseName: string,
  container: ExportContainer | undefined,
  tx: Prisma.TransactionClient | typeof prisma = prisma
) {
  // The spec's container names the extension, the same way the engine's
  // `containerExtension` does; a name alone (a tab's own claim) says it by its
  // suffix.
  const { ext } = container ? deliveryContainer(container) : containerOfName(baseName);
  const base =
    baseName.replace(/\.(mp4|mov)$/i, "").replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 60) || "export";
  const [files, jobs] = await Promise.all([
    tx.cutMediaObject.findMany({
      where: { userId, projectId, kind: "export" },
      select: { fileName: true },
    }),
    // A dismissed row stays for the day's count, and nothing sits behind its
    // name: a released browser render never uploaded, a dismissed finished one
    // is already in `files`.
    tx.cutRenderJob.findMany({
      where: { userId, projectId, kind: "export", state: { not: "dismissed" } },
      select: { outName: true },
    }),
  ]);
  const taken = new Set<string>([
    ...files.map((f) => f.fileName),
    ...jobs.map((j) => j.outName).filter((n): n is string => !!n),
  ]);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base}${ext}` : `${base} ${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export const jobsCloud = {
  /** Presign the overlay uploads for an export — stamped title and effect
   * frames, and the behind-speaker mask clip. Transient worker inputs: no
   * CutMediaObject bookkeeping, no quota.
   *
   * The content type is part of a presigned PUT's signature, so the answer
   * carries the one that was signed and the uploader sends it back verbatim.
   * Anything else is a 403 at R2. */
  async exportPresign(userId: string, req: Request) {
    try {
      const { files, target } = (await req.json()) as {
        files?: { name?: string; bytes?: number }[];
        target?: string;
      };
      if (!Array.isArray(files) || files.length === 0) return err("files is required.", 400);
      if (files.length > MAX_OVERLAY_FILES) return err("Too many overlays.", 400);
      // The overlays exist for a render, so the gates that render passes apply
      // here too: a user's export meets the daily and live caps, the editor's
      // own renders (proxy, card, ladder) only the storage margin.
      if (target === undefined || target === "export") {
        const capped = await renderJobCheck(userId);
        if (capped) return capped;
      }
      const over = await quotaCheck(userId, 0, EXPORT_QUOTA_MARGIN);
      if (over) return over;
      let total = 0;
      for (const f of files) {
        if (!Number.isInteger(f.bytes) || f.bytes! < 1) return err("Every overlay needs its size.", 400);
        if (f.bytes! > MAX_OVERLAY_BYTES) return err(`${f.name} is too large to render in the cloud.`, 413);
        total += f.bytes!;
      }
      if (total > MAX_OVERLAY_BATCH_BYTES) return err("The cut's files are too large to render in the cloud.", 413);
      const batchId = crypto.randomUUID().slice(0, 12);
      const out = await Promise.all(
        files.map(async (f) => {
          const name = String(f.name ?? "").replace(/[/\\]/g, "");
          if (!name) throw new Error("Every overlay needs a name.");
          const key = overlayKey(userId, batchId, name);
          const type = contentTypeFor(name);
          // The size is in the signature: a larger body is a 403 at the bucket.
          return { name, key, type, url: await presignPut(key, type, f.bytes) };
        })
      );
      return Response.json({ files: out });
    } catch (e) {
      return caught(e, "Could not presign the overlays.");
    }
  },

  /** Queue an export (or hover-preview) render. Same response as the engine's
   * exportApi.create: {id} or 400 {error}. */
  async exportCreate(userId: string, req: Request) {
    try {
      const body = (await req.json()) as {
        spec?: {
          target?: string;
          projectId?: string;
          container?: ExportContainer;
          clips?: { file?: string }[];
          overlayVideos?: { file?: string }[];
          audio?: { file?: string }[];
        };
        overlays?: { name: string; key: string }[];
        projectId?: string;
        outName?: string;
        burnedSubtitles?: boolean;
        /** "overlays": the cut's media was uploaded beside the stills, so the
         * project it names is not one the cloud stores — a browser-resident
         * project borrowing the worker. */
        mediaFrom?: "overlays";
      };
      if (!body.spec || typeof body.spec !== "object") return err("spec is required.", 400);
      const projectId = body.projectId ?? body.spec.projectId;
      if (!projectId) return err("projectId is required.", 400);
      const borrowed = body.mediaFrom === "overlays";
      const project = await getProject(userId, projectId);
      if (!project && !borrowed) return err("Project not found.", 400);
      // Overlay keys come from the client; only this user's own overlay
      // uploads are acceptable render inputs — anything else would let a
      // crafted key pull another account's R2 objects into the render.
      const overlayPrefix = `cut/${userId}/overlays/`;
      for (const o of body.overlays ?? []) {
        if (typeof o?.key !== "string" || !o.key.startsWith(overlayPrefix)) {
          return err("Invalid overlay key.", 400);
        }
      }
      if (borrowed) {
        // Every file the cut plays has to have come up with the job; the
        // worker has nowhere else to look for it.
        const uploaded = new Set((body.overlays ?? []).map((o) => o.name));
        const missing = specMediaFiles(body.spec).find((f) => !uploaded.has(f));
        if (missing) return err(`${missing} was not uploaded with the export.`, 400);
        if (!body.outName?.trim()) return err("outName is required.", 400);
      }
      // Hover proxies, share cards and share ladders are renders the editor
      // fires on its own; only renders the user asked for count against the
      // cap.
      const target =
        body.spec.target === "preview" ||
        body.spec.target === "card" ||
        body.spec.target === "hls"
          ? body.spec.target
          : "export";
      const refused = specRefusal(body.spec as Record<string, unknown>);
      if (refused) return err(refused, 400);
      // Every render lands bytes, so every target passes the storage margin.
      // The finished file's size isn't knowable until it renders; what is
      // knowable is whether this account is already too far past its quota to
      // be handed more, so that is the gate. The daily and live caps count
      // renders the user asked for; the editor's own renders are held to one
      // running and one queued per project below.
      if (target === "export") {
        const capped = await renderJobCheck(userId);
        if (capped) return capped;
      }
      const over = await quotaCheck(userId, 0, EXPORT_QUOTA_MARGIN);
      if (over) return over;
      const jobSpec = {
        spec: body.spec,
        overlays: body.overlays ?? [],
        ...(borrowed ? { mediaFrom: "overlays" } : {}),
        ...(target === "hls" ? { burnedSubtitles: body.burnedSubtitles === true } : {}),
      } as unknown as Prisma.InputJsonValue;

      if (target !== "export") {
        if (target === "hls") {
          // A ladder is only worth rendering for a project someone can actually
          // open: it is fired by the editor rather than asked for, so without
          // this an unshared project would burn a render slot on a stream with no
          // viewer.
          const shared = await prisma.cutProjectShare.findUnique({
            where: { projectId },
            select: { id: true },
          });
          if (!shared) return Response.json({ id: null, skipped: "not-shared" });
        }

        // The editor's own renders re-encode the cut and hold a render slot
        // for the duration, so per project at most one runs and one waits. The
        // waiting one is REPLACED rather than kept: what matters is that the
        // newest doc renders last, and returning the in-flight job's id instead
        // — as this once did — silently dropped every edit made while one was
        // running, leaving the share streaming a pre-edit cut indefinitely.
        const queued = await prisma.cutRenderJob.findFirst({
          where: { userId, projectId, kind: target, state: "queued" },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (queued) {
          const replaced = await prisma.cutRenderJob.updateMany({
            where: { id: queued.id, state: "queued" },
            data: { spec: jobSpec },
          });
          // It started between the read and the write, so it is now the running
          // job and this doc needs a fresh row behind it.
          if (replaced.count > 0) {
            wakeRenderWorker();
            return Response.json({ id: queued.id });
          }
        }
      }
      const outName =
        target === "export"
          ? await exportName(userId, projectId, body.outName?.trim() || project?.name || "export", body.spec.container)
          : target === "hls"
            ? "master.m3u8"
            : `${target}.mp4`;
      const row = await prisma.cutRenderJob.create({
        data: { userId, projectId, kind: target, spec: jobSpec, outName },
      });
      wakeRenderWorker();
      return Response.json({ id: row.id });
    } catch (e) {
      return caught(e, "Export failed to start.");
    }
  },

  /**
   * Queue a whole-timeline export for a client that cannot build a render spec
   * — the phone. The row carries the project and the size; the worker opens
   * the project document and builds the spec itself, so what renders is the
   * cut as it stands, overlays and captions and all, exactly as the web
   * dialog would have rendered it.
   */
  async exportFromDoc(userId: string, projectId: string, req: Request) {
    try {
      const body = (await req.json().catch(() => ({}))) as { preset?: string };
      const project = await getProject(userId, projectId);
      if (!project) return err("Project not found.", 404);
      const capped = await renderJobCheck(userId);
      if (capped) return capped;
      const over = await quotaCheck(userId, 0, EXPORT_QUOTA_MARGIN);
      if (over) return over;
      // The worker owns the size list (it builds the spec), and falls back to
      // the source-matched original for anything it does not know.
      const preset = typeof body.preset === "string" ? body.preset : "original";
      const outName = await exportName(userId, projectId, project.name, undefined);
      const row = await prisma.cutRenderJob.create({
        data: {
          userId,
          projectId,
          kind: "export",
          spec: { fromDoc: { preset } } as unknown as Prisma.InputJsonValue,
          outName,
        },
      });
      wakeRenderWorker();
      return Response.json({ id: row.id, outName });
    } catch (e) {
      return caught(e, "Export failed to start.");
    }
  },

  async exportStatus(userId: string, jobId: string) {
    const row = await findJob(userId, jobId);
    if (!row) return err("Unknown export.", 404);
    if (needsWorker(row)) wakeRenderWorker();
    const { status, error } = engineStatus(row);
    return Response.json({
      status,
      progress: row.progress,
      error,
      outName: row.outName || undefined,
    });
  },

  async exportCancel(userId: string, jobId: string) {
    // The worker honors "canceled" mid-run; a queued row is simply never claimed.
    const canceled = await prisma.cutRenderJob.updateMany({
      where: { id: jobId, userId, state: { in: ["queued", "running"] } },
      data: { state: "canceled" },
    });
    // A settled row is being dismissed from the dock: it leaves the feed and
    // stays on the books, so the day's render count still sees it. A finished
    // file survives as the project's export media object — except a borrowed
    // render's, which was the job's scratch and goes with the row.
    if (canceled.count === 0) {
      const row = await findJob(userId, jobId);
      if (row && ["done", "error", "canceled"].includes(row.state)) {
        await prisma.cutRenderJob.update({ where: { id: row.id }, data: { state: "dismissed" } });
        if (row.outputKey?.startsWith(overlayPrefix(userId))) await del([row.outputKey]);
      }
    }
    return Response.json({ ok: true });
  },

  /**
   * Claim a name and a destination for an export the browser renders itself.
   *
   * The gates a queued render passes on its way in have to be passed here too —
   * the concurrent-render cap and the storage margin — because a browser render
   * is still a render this account asked for and still lands as a stored file.
   * The name is deduped here, where the rows are, exactly as it is for the
   * worker.
   */
  async exportClientPresign(userId: string, req: Request) {
    try {
      const body = (await req.json()) as { projectId?: string; outName?: string };
      const projectId = body.projectId;
      if (!projectId) return err("projectId is required.", 400);
      if (!(await getProject(userId, projectId))) return err("Project not found.", 400);
      const capped = await renderJobCheck(userId);
      if (capped) return capped;
      const over = await quotaCheck(userId, 0, EXPORT_QUOTA_MARGIN);
      if (over) return over;
      // The name is claimed by writing the row, not just by reading the rows
      // that exist. `exportName` dedupes against stored objects and jobs, so a
      // second export started while this one renders has to see this one — two
      // tabs exporting the same project would otherwise both be handed
      // "export.mp4", the second upload would overwrite the first, and the
      // completion would then fail on the unique key with the render already
      // spent. The row is the reservation.
      const row = await prisma.$transaction(async (tx) => {
        const outName = await exportName(userId, projectId, body.outName ?? "export.mp4", undefined, tx);
        return tx.cutRenderJob.create({
          data: {
            userId,
            projectId,
            kind: "export",
            // Rendering, in the tab rather than on the worker — which is why
            // nothing ever claims it.
            state: "running",
            progress: 0,
            spec: { client: true },
            outName,
          },
        });
      });
      const key = projectExportKey(userId, projectId, row.outName!);
      const type = containerOfName(row.outName!).mime;
      return Response.json({
        jobId: row.id,
        key,
        outName: row.outName,
        type,
        url: await presignPut(key, type),
      });
    } catch (e) {
      return caught(e, "Could not start the export.");
    }
  },

  /**
   * Register a browser-rendered export that has finished uploading.
   *
   * The row is written already finished, because it is: the render happened in
   * the tab and the bytes are in the bucket before this is called. That is the
   * whole difference from a queued export — there is no state for the client to
   * poll towards, so the dock's next refresh simply finds a completed job.
   *
   * The object's size is read from the bucket rather than taken from the
   * client, since it is what the account's storage is charged.
   */
  async exportClientComplete(userId: string, req: Request) {
    try {
      const body = (await req.json()) as { jobId?: string };
      if (!body.jobId) return err("jobId is required.", 400);
      // The row the presign reserved carries the project and the name, so the
      // client cannot claim a different one at completion time.
      const row = await findJob(userId, body.jobId);
      if (!row || row.kind !== "export" || !row.projectId || !row.outName) {
        return err("Export not found.", 400);
      }
      if (row.state === "canceled") return err("Export canceled.", 400);
      const { projectId, outName } = row;
      const key = projectExportKey(userId, projectId, outName);
      const object = await head(key);
      if (!object) return err("The export was not uploaded.", 400);
      const bytes = object.bytes;
      await prisma.$transaction(async (tx) => {
        await tx.cutMediaObject.create({
          data: {
            userId,
            projectId,
            r2Key: key,
            fileName: outName,
            mime: containerOfName(outName).mime,
            bytes: BigInt(bytes),
            kind: "export",
            uploadState: "complete",
          },
        });
        await addUsage(tx, userId, bytes);
        await tx.cutRenderJob.update({
          where: { id: row.id },
          data: { state: "done", progress: 1, outputKey: key },
        });
      });
      return Response.json({ id: row.id, outName });
    } catch (e) {
      return caught(e, "Could not save the export.");
    }
  },

  /**
   * Give back a name a browser render claimed but will not use.
   *
   * The row is dismissed rather than marked canceled: nothing rendered, so there
   * is nothing to report, and a canceled row would put a failure card in the
   * dock for a render the user themselves stopped. It stays on the books for
   * the day's count, and anything the tab already uploaded under the claimed
   * name goes with it.
   */
  async exportClientRelease(userId: string, jobId: string) {
    try {
      const row = await findJob(userId, jobId);
      if (row && row.kind === "export" && (row.state === "running" || row.state === "queued")) {
        await dropUnregisteredExport(userId, row);
        await prisma.cutRenderJob.updateMany({
          where: { id: row.id, state: { in: ["running", "queued"] } },
          data: { state: "dismissed" },
        });
      }
      return Response.json({ ok: true });
    } catch (e) {
      return caught(e, "Could not release the export.");
    }
  },

  async exportFile(userId: string, jobId: string) {
    try {
      const row = await findJob(userId, jobId);
      if (!row || row.state !== "done" || !row.outputKey) {
        return new Response("Export not ready.", { status: 404 });
      }
      // A finished job's output never changes, so the redirect is cacheable.
      return redirect(
        mediaObjectUrl(row.outputKey, row.outName ? { downloadName: row.outName } : undefined),
        MEDIA_REDIRECT_HEADERS
      );
    } catch (e) {
      return caught(e, "Export not ready.");
    }
  },

  /** The exports-dock feed: every export job for this account, start order —
   * same view the engine's listAllJobs builds (previews stay internal). */
  async exportFeed(userId: string) {
    // A browser render lives in a tab, and a tab can close mid-render. Nothing
    // claims those rows, so nothing else would ever release them, and each one
    // left behind holds a name and a render slot for good. Any that have been
    // running longer than a render plausibly takes are swept here, on the poll
    // that would have displayed them: the row is dismissed (kept for the day's
    // count) and a file the tab uploaded without registering goes.
    const stale = await prisma.cutRenderJob.findMany({
      where: {
        userId,
        kind: "export",
        state: "running",
        claimedAt: null,
        updatedAt: { lt: new Date(Date.now() - CLIENT_RENDER_WINDOW_MS) },
      },
    });
    for (const row of stale) {
      await dropUnregisteredExport(userId, row).catch(() => {});
      await prisma.cutRenderJob
        .updateMany({ where: { id: row.id, state: "running" }, data: { state: "dismissed" } })
        .catch(() => {});
    }
    const rows = await prisma.cutRenderJob.findMany({
      where: {
        userId,
        kind: "export",
        state: { not: "dismissed" },
        OR: [
          { state: { in: ["queued", "running"] } },
          { createdAt: { gte: new Date(Date.now() - FEED_WINDOW_MS) } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    const projectIds = [...new Set(rows.map((r) => r.projectId).filter((p): p is string => !!p))];
    const projects = await prisma.cutProject.findMany({
      where: { userId, id: { in: projectIds } },
      select: { id: true, name: true },
    });
    const names = new Map(projects.map((p) => [p.id, p.name]));
    return Response.json(
      rows.map((r) => {
        const { status, error } = engineStatus(r);
        return {
          id: r.id,
          projectId: r.projectId ?? "",
          projectName: names.get(r.projectId ?? "") ?? "",
          status,
          progress: r.progress,
          outName: r.outName || undefined,
          error,
          createdAt: r.createdAt.getTime(),
          startedAt: r.claimedAt?.getTime(),
        };
      })
    );
  },

  /** Queue a URL import — async on the cloud (the worker downloads), unlike the
   * engine's synchronous route. */
  async importUrl(userId: string, projectId: string, req: Request) {
    try {
      const { url, audio } = (await req.json()) as { url?: string; audio?: boolean };
      if (!url) return err("No URL provided.", 400);
      if (!(await getProject(userId, projectId))) return err("Project not found.", 404);
      const capped = await renderJobCheck(userId);
      if (capped) return capped;
      // What lands counts against storage, so an account with none left gets
      // no download, and the worker downloads no more than what is left.
      const over = await quotaCheck(userId, 0);
      if (over) return over;
      const maxBytes = await importByteCeiling(userId);
      const row = await prisma.cutRenderJob.create({
        data: {
          userId,
          projectId,
          kind: "import_url",
          spec: {
            url,
            maxBytes,
            ...(audio === true ? { audio: true } : {}),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      wakeRenderWorker();
      return Response.json({ jobId: row.id });
    } catch (e) {
      return caught(e, "Could not import that URL.");
    }
  },

  /** Queue a URL import into the shared library. No project owns it: the
   * worker lands the files under the account's library prefix and registers
   * the assets, and the client polls this job for them. */
  async importUrlToLibrary(userId: string, req: Request) {
    try {
      const { url, origin, audio } = (await req.json()) as {
        url?: string;
        origin?: string;
        audio?: boolean;
      };
      if (!url) return err("No URL provided.", 400);
      const capped = await renderJobCheck(userId);
      if (capped) return capped;
      const over = await quotaCheck(userId, 0);
      if (over) return over;
      const maxBytes = await importByteCeiling(userId);
      const row = await prisma.cutRenderJob.create({
        data: {
          userId,
          kind: "import_url",
          spec: {
            url,
            maxBytes,
            target: "library",
            ...(audio === true ? { audio: true } : {}),
            // An inspiration link's downloads land in the Inspiration folder,
            // carrying the origin the Camera Roll and Library filters read.
            ...(origin === "inspiration" ? { origin } : {}),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      wakeRenderWorker();
      return Response.json({ jobId: row.id });
    } catch (e) {
      return caught(e, "Could not import that URL.");
    }
  },

  /** Queue a media conversion: the worker rewrites one of the project's media
   * files as MP4 and registers it beside the original. */
  async convert(userId: string, projectId: string, req: Request) {
    try {
      const { file, maxHeight } = (await req.json()) as { file?: string; maxHeight?: number };
      if (!file) return err("file is required.", 400);
      if (!(await getProject(userId, projectId))) return err("Project not found.", 404);
      const over = await quotaCheck(userId, 0, EXPORT_QUOTA_MARGIN);
      if (over) return over;
      const source = await prisma.cutMediaObject.findFirst({
        where: { userId, projectId, fileName: file, kind: "media" },
        select: { id: true },
      });
      if (!source) return err("Media file missing from project.", 404);
      const capped = await renderJobCheck(userId);
      if (capped) return capped;
      const row = await prisma.cutRenderJob.create({
        data: {
          userId,
          projectId,
          kind: "convert",
          spec: { file, ...(maxHeight ? { maxHeight } : {}) } as unknown as Prisma.InputJsonValue,
        },
      });
      wakeRenderWorker();
      return Response.json({ jobId: row.id });
    } catch (e) {
      return caught(e, "Could not convert that file.");
    }
  },

  /** Generic job poll for non-export kinds (import_url, convert). */
  async status(userId: string, jobId: string) {
    const row = await findJob(userId, jobId);
    if (!row) return err("Unknown job.", 404);
    if (needsWorker(row)) wakeRenderWorker();
    return Response.json({
      id: row.id,
      kind: row.kind,
      state: row.state,
      progress: row.progress,
      result: row.result ?? undefined,
      error: row.error ?? undefined,
    });
  },
};
