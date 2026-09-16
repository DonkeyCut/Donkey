import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getCreditBalance } from "@/lib/credits/inference";
import { getActiveProSubscription } from "@/lib/billing/pro-subscription";
import { isDonkeySuperUser } from "@/lib/donkey-api-auth";
import { normalizeAspect, type ProjectDoc } from "@/cut/lib/types";
import { queueCommands, waitForJob, type CommandCall, type CommandJobResult, type JobRow } from "@/cut/server/cloud/commands";
import { historyState, HistoryError, restoreCheckpoint } from "@/cut/server/cloud/history";
import { queueDocExport, queueImportUrl } from "@/cut/server/cloud/jobs";
import { cutLimitsFor } from "@/cut/server/cloud/limits";
import { previewFromDoc } from "@/cut/server/cloud/previewJobs";
import { mediaObjectUrl, mediaUrlLifetime } from "@/cut/server/cloud/mediaCdn";
import { usageBytes } from "@/cut/server/cloud/usage";
import { wakeRenderWorker } from "@/cut/server/cloud/wake";
import type { ImportUrlResult } from "@/cut/worker/importUrlJob";
import type { Download, Playback, ProjectView } from "@/clients/chatgpt/contracts";
import type { ChatgptConfig } from "@/clients/chatgpt/server/config";
import { READ_COMMANDS, unknownCommandNames } from "@/clients/chatgpt/server/catalog";

type Identity = { userId: string; scopes: string[] };
export class ProjectToolError extends Error {}
export type ProjectResult = { view: ProjectView; playback: Playback | null; download?: Download | null };

/** A queue helper's refusal, read out of its Response as a message. */
async function refusal(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; bytes?: number; quotaBytes?: number };
  if (body.error === "storage_quota_exceeded")
    throw new ProjectToolError(
      `The account's cloud storage is full (${mb(body.bytes ?? 0)} of ${mb(body.quotaBytes ?? 0)} MB). Delete media or exports in Donkey Cut, or upgrade the plan.`
    );
  throw new ProjectToolError(body.error ?? "Donkey Cut refused the request.");
}

const mb = (bytes: number) => Math.round(bytes / 1024 ** 2);

const jobStatus = (row: Pick<JobRow, "state">): "queued" | "running" | "done" | "error" =>
  row.state === "queued" || row.state === "running" || row.state === "done" ? row.state : "error";

const jobError = (row: Pick<JobRow, "state" | "error">) =>
  row.state === "canceled" ? "The job was canceled." : row.error ?? undefined;

export function projectTools(
  identity: Identity,
  config: ChatgptConfig,
  db = prisma,
) {
  const canRender = identity.scopes.includes("previews:render");
  const canEdit = identity.scopes.includes("projects:write");
  const projectSummary = (row: {
    id: string;
    name: string;
    version: number;
  }) => ({
    id: row.id,
    name: row.name,
    revision: `cloud:${row.version}`,
    url: `${config.issuer}/app/p/${encodeURIComponent(row.id)}`,
  });
  const emptyProjectView = (): ProjectView => ({
    view: "projects",
    projects: [],
    nextCursor: null,
    project: null,
    preview: null,
    canRender,
    canEdit,
    export: null,
    job: null,
    results: [],
    changed: false,
    history: null,
    account: null,
  });

  async function getOwnedRow(projectId: string) {
    const row = await db.cutProject.findFirst({
      where: { id: projectId, userId: identity.userId },
      select: { id: true, name: true, version: true, previewKey: true },
    });
    if (!row) {
      throw new ProjectToolError(
        "Project not found. Choose one of your cloud projects.",
      );
    }
    return row;
  }

  async function getOwnedProject(projectId: string) {
    return projectSummary(await getOwnedRow(projectId));
  }

  /** The project view with its undo state, as every edit tool answers. */
  async function projectView(projectId: string): Promise<ProjectView> {
    const project = await getOwnedProject(projectId);
    const version = Number(project.revision.slice("cloud:".length));
    return {
      ...emptyProjectView(),
      view: "project",
      project,
      history: await historyState(db, identity.userId, projectId, version),
    };
  }

  function requireEdit() {
    if (!canEdit) throw new ProjectToolError("Reconnect Donkey Cut with editing permission.");
  }

  async function getPreviewStatus(
    projectId: string,
    jobId?: string,
  ): Promise<ProjectResult> {
    const row = await getOwnedRow(projectId);
    const selectedProject = projectSummary(row);
    const job = await db.cutRenderJob.findFirst({
      where: {
        userId: identity.userId,
        projectId,
        kind: "preview",
        ...(jobId
          ? { id: jobId }
          : { state: { in: ["queued", "running", "done"] } }),
      },
      orderBy: { createdAt: "desc" },
    });
    const view: ProjectView = {
      ...emptyProjectView(),
      view: "project",
      project: selectedProject,
    };
    if (!job) {
      if (jobId) {
        throw new ProjectToolError(
          "Preview not found. Open the project again.",
        );
      }
      return { view, playback: null };
    }

    const isStaleRender =
      job.state === "running" && job.updatedAt.getTime() < Date.now() - 30_000;
    if (job.state === "queued" || isStaleRender) {
      wakeRenderWorker();
    }

    const status = jobStatus(job);
    view.preview = {
      id: job.id,
      status,
      progress: Math.max(0, Math.min(1, job.progress)),
      // The editor keeps previewKey on the proxy it rendered for the saved
      // document, and the share page serves that pointer as current; so does
      // this card, so a project plays the moment it opens.
      revision:
        (job.spec as { revision?: string } | null)?.revision ??
        (job.outputKey && job.outputKey === row.previewKey ? selectedProject.revision : null),
    };
    if (status === "error") {
      view.preview.error = "Preview could not finish. Render a new preview.";
    }
    if (status !== "done") {
      return { view, playback: null };
    }

    const media = job.outputKey
      ? await db.cutMediaObject.findFirst({
          where: {
            r2Key: job.outputKey,
            userId: identity.userId,
            projectId,
            kind: "preview",
            uploadState: "complete",
          },
          select: { r2Key: true },
        })
      : null;
    if (!media) {
      view.preview.status = "expired";
      return { view, playback: null };
    }

    return {
      view,
      playback: {
        url: mediaObjectUrl(media.r2Key),
        expiresAt: Date.now() + mediaUrlLifetime() * 1000,
      },
    };
  }

  /** An export job as the widget and the model see it. */
  async function exportView(row: JobRow): Promise<ProjectResult> {
    if (!row.projectId) throw new ProjectToolError("Export not found.");
    const view = await projectView(row.projectId);
    const status = jobStatus(row);
    view.export = { id: row.id, status, progress: Math.max(0, Math.min(1, row.progress)), name: row.outName, ...(jobError(row) ? { error: jobError(row) } : {}) };
    if (status !== "done" || !row.outputKey) {
      if (status === "queued" || status === "running") wakeRenderWorker();
      return { view, playback: null, download: null };
    }
    const media = await db.cutMediaObject.findFirst({
      where: { r2Key: row.outputKey, userId: identity.userId, kind: "export", uploadState: "complete" },
      select: { r2Key: true },
    });
    if (!media) {
      view.export.status = "expired";
      view.export.error = "The export file was deleted. Export again.";
      return { view, playback: null, download: null };
    }
    return {
      view,
      playback: null,
      download: {
        url: mediaObjectUrl(media.r2Key, row.outName ? { downloadName: row.outName } : undefined),
        expiresAt: Date.now() + mediaUrlLifetime() * 1000,
        name: row.outName ?? "export.mp4",
      },
    };
  }

  /** A commands or import job as a result: settled rows carry their
   * outcomes; a row still running carries the job for a later poll. */
  async function jobView(row: JobRow): Promise<ProjectResult> {
    if (row.kind === "export") return exportView(row);
    if (row.kind === "preview" && row.projectId) return getPreviewStatus(row.projectId, row.id);
    if (!row.projectId) throw new ProjectToolError("Job not found.");
    const view = await projectView(row.projectId);
    const status = jobStatus(row);
    view.job = { id: row.id, kind: row.kind, status, progress: Math.max(0, Math.min(1, row.progress)), ...(jobError(row) ? { error: jobError(row) } : {}) };
    if (status === "queued" || status === "running") wakeRenderWorker();
    if (status !== "done") return { view, playback: null };
    if (row.kind === "commands") {
      const result = row.result as CommandJobResult | null;
      view.results = result?.results ?? [];
      view.changed = result?.changed ?? false;
    } else if (row.kind === "import_url") {
      const result = row.result as ImportUrlResult | null;
      view.results = [{ name: "import_media", ok: true, output: { assets: result?.assets ?? [], ...(result?.text ? { sourceText: result.text } : {}) } }];
      view.changed = (result?.assets?.length ?? 0) > 0;
    }
    return { view, playback: null };
  }

  async function ownedJob(jobId: string): Promise<JobRow> {
    const row = await db.cutRenderJob.findFirst({ where: { id: jobId, userId: identity.userId } });
    if (!row) throw new ProjectToolError("Job not found.");
    return row;
  }

  /** Queue a batch and wait on it within the call's budget. */
  async function runBatch(projectId: string, commands: CommandCall[], opts: { readOnly?: boolean; label?: string }): Promise<ProjectResult> {
    await getOwnedProject(projectId);
    const unknown = unknownCommandNames(commands.map((c) => c.name));
    if (unknown.length)
      throw new ProjectToolError(`Unknown command${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Call list_commands for the catalog.`);
    const queued = await queueCommands(identity.userId, projectId, { commands, ...opts });
    if (queued instanceof Response) return refusal(queued);
    const row = await waitForJob(identity.userId, queued.id, config.commandWaitMs);
    if (!row) throw new ProjectToolError("The job disappeared. Try again.");
    return jobView(row);
  }

  return {
    async list(cursor?: string): Promise<ProjectResult> {
      // A cursor names an account-owned row, so a foreign id cannot influence pagination.
      if (cursor) {
        await getOwnedProject(cursor);
      }
      const rows = await db.cutProject.findMany({
        where: { userId: identity.userId },
        select: { id: true, name: true, version: true },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 21,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      return {
        view: {
          ...emptyProjectView(),
          projects: rows.slice(0, 20).map(projectSummary),
          nextCursor: rows.length > 20 ? rows[19].id : null,
        },
        playback: null,
      };
    },
    status: getPreviewStatus,
    async render(projectId: string): Promise<ProjectResult> {
      if (!canRender) {
        throw new ProjectToolError(
          "Reconnect Donkey Cut with preview rendering permission.",
        );
      }
      const current = await getPreviewStatus(projectId);
      if (current.playback && current.view.preview?.revision === current.view.project?.revision) return current;
      const job = await previewFromDoc(identity.userId, projectId);
      if (!job) {
        throw new ProjectToolError(
          "Project not found. Choose one of your cloud projects.",
        );
      }
      return getPreviewStatus(projectId, job.id);
    },

    async create(name: string, aspect?: string): Promise<ProjectResult> {
      requireEdit();
      const frame = aspect ? normalizeAspect(aspect) : null;
      if (aspect && !frame) throw new ProjectToolError('aspect must be "W:H", like "9:16" or "16:9".');
      const now = Date.now();
      const doc: ProjectDoc = {
        version: 1,
        name: name.trim() || "Untitled",
        createdAt: now,
        updatedAt: now,
        assets: [],
        clips: [],
        audioClips: [],
        overlays: [],
        ...(frame ? { aspect: frame } : {}),
      };
      const row = await db.cutProject.create({
        data: { userId: identity.userId, name: doc.name, doc: doc as unknown as Prisma.InputJsonValue },
        select: { id: true, name: true, version: true },
      });
      return { view: { ...emptyProjectView(), view: "project", project: projectSummary(row), history: { undo: null, redo: null } }, playback: null };
    },

    async inspect(projectId: string, commands?: CommandCall[]): Promise<ProjectResult> {
      const calls = commands?.length ? commands : [{ name: "get_state", input: {} }];
      const writes = calls.filter((c) => c.name !== "get_state" && !READ_COMMANDS.has(c.name)).map((c) => c.name);
      if (writes.length)
        throw new ProjectToolError(`inspect_project runs reads only; ${writes.join(", ")} edit the project — send them through edit_project.`);
      return runBatch(projectId, calls, { readOnly: true });
    },

    async edit(projectId: string, commands: CommandCall[], label?: string): Promise<ProjectResult> {
      requireEdit();
      return runBatch(projectId, commands, { label });
    },

    async importMedia(projectId: string, items: { url: string; name?: string }[], audioOnly: boolean): Promise<ProjectResult> {
      requireEdit();
      await getOwnedProject(projectId);
      const ids: string[] = [];
      for (const item of items) {
        const queued = await queueImportUrl(identity.userId, projectId, {
          url: item.url,
          audio: audioOnly,
          adopt: item.name ? { name: item.name } : {},
        });
        if (queued instanceof Response) {
          if (ids.length === 0) return refusal(queued);
          break;
        }
        ids.push(queued.id);
      }
      const deadline = Date.now() + config.commandWaitMs;
      const rows: JobRow[] = [];
      for (const id of ids) {
        const row = await waitForJob(identity.userId, id, Math.max(0, deadline - Date.now()));
        if (row) rows.push(row);
      }
      const view = await projectView(projectId);
      const pending = rows.filter((r) => r.state === "queued" || r.state === "running");
      for (const row of rows) {
        const status = jobStatus(row);
        if (status === "done") {
          const result = row.result as ImportUrlResult | null;
          view.results.push({ name: "import_media", ok: true, output: { jobId: row.id, assets: result?.assets ?? [], ...(result?.text ? { sourceText: result.text } : {}) } });
          view.changed ||= (result?.assets?.length ?? 0) > 0;
        } else if (status === "error") {
          view.results.push({ name: "import_media", ok: false, error: jobError(row) ?? "The import failed." });
        }
      }
      // Every unfinished import names its job, so none is lost once the call
      // returns; the first one is the job the view carries.
      for (const row of pending)
        view.results.push({ name: "import_media", ok: true, output: { jobId: row.id, status: jobStatus(row) } });
      if (pending.length) {
        const row = pending[0];
        view.job = { id: row.id, kind: row.kind, status: jobStatus(row), progress: row.progress };
      }
      if (ids.length < items.length)
        view.results.push({ name: "import_media", ok: false, error: `${items.length - ids.length} item(s) were not queued: the account's job cap was reached.` });
      return { view, playback: null };
    },

    async undo(projectId: string): Promise<ProjectResult> {
      requireEdit();
      await getOwnedProject(projectId);
      const step = await restoreCheckpoint(db, identity.userId, projectId, "undo").catch((e) => {
        throw e instanceof HistoryError ? new ProjectToolError(e.message) : e;
      });
      const view = await projectView(projectId);
      view.changed = true;
      view.results = [{ name: "undo", ok: true, output: { undone: step.label } }];
      return { view, playback: null };
    },

    async redo(projectId: string): Promise<ProjectResult> {
      requireEdit();
      await getOwnedProject(projectId);
      const step = await restoreCheckpoint(db, identity.userId, projectId, "redo").catch((e) => {
        throw e instanceof HistoryError ? new ProjectToolError(e.message) : e;
      });
      const view = await projectView(projectId);
      view.changed = true;
      view.results = [{ name: "redo", ok: true, output: { redone: step.label } }];
      return { view, playback: null };
    },

    async exportVideo(projectId: string, preset: string): Promise<ProjectResult> {
      requireEdit();
      const queued = await queueDocExport(identity.userId, projectId, preset);
      if (queued instanceof Response) return refusal(queued);
      const row = await waitForJob(identity.userId, queued.id, config.commandWaitMs);
      if (!row) throw new ProjectToolError("The export disappeared. Try again.");
      return exportView(row);
    },

    async exportStatus(jobId: string): Promise<ProjectResult> {
      const row = await ownedJob(jobId);
      if (row.kind !== "export") throw new ProjectToolError("That job is not an export.");
      return exportView(row);
    },

    async jobStatus(jobId: string): Promise<ProjectResult> {
      return jobView(await ownedJob(jobId));
    },

    async account(): Promise<ProjectResult> {
      const [credits, bytes, limits, superUser, pro] = await Promise.all([
        getCreditBalance(identity.userId),
        usageBytes(identity.userId),
        cutLimitsFor(identity.userId),
        isDonkeySuperUser(identity.userId),
        getActiveProSubscription(identity.userId),
      ]);
      const view = emptyProjectView();
      view.account = {
        credits: credits.balance,
        storageBytes: bytes,
        storageQuotaBytes: limits.storageBytes,
        plan: superUser ? "unlimited" : pro ? "pro" : "free",
      };
      return { view, playback: null };
    },
  };
}
