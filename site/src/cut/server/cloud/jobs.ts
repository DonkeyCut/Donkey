// Render-job rows for the cloud worker (site/src/cut/worker). These routes only
// manage CutRenderJob rows — the worker claims and executes them. Response
// shapes byte-match the engine's export routes (http/export.ts + server/jobs.ts).
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { EXPORT_QUOTA_MARGIN, renderJobCheck } from "./limits";
import { wakeRenderWorker } from "./wake";
import { getProject } from "./projects";
import { mediaObjectUrl } from "./mediaCdn";
import { overlayKey, presignPut } from "./r2";
import { quotaCheck } from "./usage";
import { caught, err, redirect } from "./util";

/** How long finished jobs stay in the export-jobs feed — the engine's registry
 * keeps a bounded terminal backlog; the cloud keeps a day. */
const FEED_WINDOW_MS = 24 * 60 * 60 * 1000;

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
async function exportName(userId: string, projectId: string, baseName: string) {
  const base =
    baseName.replace(/\.mp4$/i, "").replace(/[/\\:*?"<>|]/g, "").trim().slice(0, 60) || "export";
  const [files, jobs] = await Promise.all([
    prisma.cutMediaObject.findMany({
      where: { userId, projectId, kind: "export" },
      select: { fileName: true },
    }),
    prisma.cutRenderJob.findMany({
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
  /** Presign overlay-PNG uploads for an export. Overlays are transient worker
   * inputs — no CutMediaObject bookkeeping, no quota. */
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
          return { name, key, url: await presignPut(key, "image/png") };
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
      // Hover proxies and share cards are small internal renders the editor
      // fires on its own; only renders the user asked for count against the
      // cap.
      const target = body.spec.target === "preview" || body.spec.target === "card"
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
      const outName =
        target === "export"
          ? await exportName(userId, projectId, body.outName?.trim() || project.name)
          : `${target}.mp4`;
      const row = await prisma.cutRenderJob.create({
        data: {
          userId,
          projectId,
          kind: target,
          spec: {
            spec: body.spec,
            overlays: body.overlays ?? [],
          } as unknown as Prisma.InputJsonValue,
          outName,
        },
      });
      wakeRenderWorker();
      return Response.json({ id: row.id });
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

  async exportFile(userId: string, jobId: string) {
    try {
      const row = await findJob(userId, jobId);
      if (!row || row.state !== "done" || !row.outputKey) {
        return new Response("Export not ready.", { status: 404 });
      }
      return redirect(
        mediaObjectUrl(row.outputKey, row.outName ? { downloadName: row.outName } : undefined)
      );
    } catch (e) {
      return caught(e, "Export not ready.");
    }
  },

  /** The exports-dock feed: every export job for this account, start order —
   * same view the engine's listAllJobs builds (previews stay internal). */
  async exportFeed(userId: string) {
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
      const { url } = (await req.json()) as { url?: string };
      if (!url) return err("No URL provided.", 400);
      if (!(await getProject(userId, projectId))) return err("Project not found.", 404);
      const capped = await renderJobCheck(userId);
      if (capped) return capped;
      const row = await prisma.cutRenderJob.create({
        data: {
          userId,
          projectId,
          kind: "import_url",
          spec: { url } as unknown as Prisma.InputJsonValue,
        },
      });
      wakeRenderWorker();
      return Response.json({ jobId: row.id });
    } catch (e) {
      return caught(e, "Could not import that URL.");
    }
  },

  /** Generic job poll for non-export kinds (import_url). */
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
