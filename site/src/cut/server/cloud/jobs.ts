// Render-job rows for the cloud worker (site/src/cut/worker). These routes only
// manage CutRenderJob rows — the worker claims and executes them. Response
// shapes byte-match the engine's export routes (http/export.ts + server/jobs.ts).
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { EXPORT_QUOTA_MARGIN, renderJobCheck } from "./limits";
import { wakeRenderWorker } from "./wake";
import { getProject } from "./projects";
import { MEDIA_REDIRECT_HEADERS, mediaObjectUrl } from "./mediaCdn";
import { head, overlayKey, presignPut, projectExportKey } from "./r2";
import { addUsage, quotaCheck } from "./usage";
import { caught, err, redirect } from "./util";

/** How long finished jobs stay in the export-jobs feed — the engine's registry
 * keeps a bounded terminal backlog; the cloud keeps a day. */
const FEED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How long a browser render may hold its reserved name before it is treated
 * as a tab that went away. Generous next to the ten-minute cut the client will
 * take on, because the wall-clock cost of a render depends on the machine. */
const CLIENT_RENDER_WINDOW_MS = 2 * 60 * 60 * 1000;

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
};

/** Engine job status ("queued" | "running" | "done" | "error") from a row's
 * state; a canceled row reads as the engine's canceled-export error. */
function engineStatus(row: JobRow): { status: string; error?: string } {
  if (row.state === "canceled") return { status: "error", error: row.error ?? "Export canceled." };
  return { status: row.state, error: row.error ?? undefined };
}

async function findJob(userId: string, id: string): Promise<JobRow | null> {
  return prisma.cutRenderJob.findFirst({ where: { id, userId } });
}

/** Engine-style export name: `base.mp4` with a " 2", " 3"… suffix when taken
 * by an existing export object or a job still in flight. The client derives the
 * base from the project name; the dedupe happens here, where the rows are. */
async function exportName(
  userId: string,
  projectId: string,
  baseName: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma
) {
  const base =
    baseName.replace(/\.mp4$/i, "").replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 60) || "export";
  const [files, jobs] = await Promise.all([
    tx.cutMediaObject.findMany({
      where: { userId, projectId, kind: "export" },
      select: { fileName: true },
    }),
    tx.cutRenderJob.findMany({
      where: { userId, projectId, kind: "export" },
      select: { outName: true },
    }),
  ]);
  const taken = new Set<string>([
    ...files.map((f) => f.fileName),
    ...jobs.map((j) => j.outName).filter((n): n is string => !!n),
  ]);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${base}.mp4` : `${base} ${n}.mp4`;
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
      const { files } = (await req.json()) as { files?: { name?: string; bytes?: number }[] };
      if (!Array.isArray(files) || files.length === 0) return err("files is required.", 400);
      const batchId = crypto.randomUUID().slice(0, 12);
      const out = await Promise.all(
        files.map(async (f) => {
          const name = String(f.name ?? "").replace(/[/\\]/g, "");
          if (!name) throw new Error("Every overlay needs a name.");
          const key = overlayKey(userId, batchId, name);
          const type = name.toLowerCase().endsWith(".mp4") ? "video/mp4" : "image/png";
          return { name, key, type, url: await presignPut(key, type) };
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
        spec?: { target?: string; projectId?: string };
        overlays?: { name: string; key: string }[];
        projectId?: string;
        outName?: string;
        burnedSubtitles?: boolean;
      };
      if (!body.spec || typeof body.spec !== "object") return err("spec is required.", 400);
      const projectId = body.projectId ?? body.spec.projectId;
      if (!projectId) return err("projectId is required.", 400);
      const project = await getProject(userId, projectId);
      if (!project) return err("Project not found.", 400);
      // Overlay keys come from the client; only this user's own overlay
      // uploads are acceptable render inputs — anything else would let a
      // crafted key pull another account's R2 objects into the render.
      const overlayPrefix = `cut/${userId}/overlays/`;
      for (const o of body.overlays ?? []) {
        if (typeof o?.key !== "string" || !o.key.startsWith(overlayPrefix)) {
          return err("Invalid overlay key.", 400);
        }
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
      if (target === "export") {
        const capped = await renderJobCheck(userId);
        if (capped) return capped;
        // The finished file is registered like any other object, so an export
        // grows storage. The output's size isn't knowable until it renders;
        // what is knowable is whether this account is already too far past its
        // quota to be handed more, so that is the gate. Previews and share
        // cards are the editor's own small internal renders and skip it.
        const over = await quotaCheck(userId, 0, EXPORT_QUOTA_MARGIN);
        if (over) return over;
      }
      const jobSpec = {
        spec: body.spec,
        overlays: body.overlays ?? [],
        ...(target === "hls" ? { burnedSubtitles: body.burnedSubtitles === true } : {}),
      } as unknown as Prisma.InputJsonValue;

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

        // A ladder re-encodes the whole cut once per rung and holds a render
        // slot for the duration, so at most one runs and one waits. The waiting
        // one is REPLACED rather than kept: what matters is that the newest doc
        // renders last, and returning the in-flight job's id instead — as this
        // once did — silently dropped every edit made while one was running,
        // leaving the share streaming a pre-edit cut indefinitely.
        const queued = await prisma.cutRenderJob.findFirst({
          where: { userId, projectId, kind: "hls", state: "queued" },
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
          ? await exportName(userId, projectId, body.outName?.trim() || project.name)
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
      const outName = await exportName(userId, projectId, project.name);
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
    // "running" wakes too: if the worker died mid-job, the woken replacement
    // sweeps the stale row back to queued and picks it up.
    if (row.state === "queued" || row.state === "running") wakeRenderWorker();
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
    // A settled row is being dismissed from the dock: drop it from the feed
    // for good. A finished file survives as the project's export media object.
    if (canceled.count === 0) {
      await prisma.cutRenderJob.deleteMany({
        where: { id: jobId, userId, state: { in: ["done", "error", "canceled"] } },
      });
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
        const outName = await exportName(userId, projectId, body.outName ?? "export.mp4", tx);
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
      return Response.json({
        jobId: row.id,
        key,
        outName: row.outName,
        url: await presignPut(key, "video/mp4"),
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
            mime: "video/mp4",
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
   * The row is deleted rather than marked canceled: nothing rendered, so there
   * is nothing to report, and a canceled row would put a failure card in the
   * dock for a render the user themselves stopped.
   */
  async exportClientRelease(userId: string, jobId: string) {
    try {
      await prisma.cutRenderJob.deleteMany({
        where: { id: jobId, userId, kind: "export", state: { in: ["running", "queued"] } },
      });
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
    // that would have displayed them.
    await prisma.cutRenderJob
      .deleteMany({
        where: {
          userId,
          kind: "export",
          state: "running",
          claimedAt: null,
          updatedAt: { lt: new Date(Date.now() - CLIENT_RENDER_WINDOW_MS) },
        },
      })
      .catch(() => {});
    const rows = await prisma.cutRenderJob.findMany({
      where: {
        userId,
        kind: "export",
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
      const row = await prisma.cutRenderJob.create({
        data: {
          userId,
          projectId,
          kind: "import_url",
          spec: { url, ...(audio === true ? { audio: true } : {}) } as unknown as Prisma.InputJsonValue,
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
      const row = await prisma.cutRenderJob.create({
        data: {
          userId,
          kind: "import_url",
          spec: {
            url,
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
    if (row.state === "queued" || row.state === "running") wakeRenderWorker();
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
