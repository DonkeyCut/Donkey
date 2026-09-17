import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { getCreditBalance } from "@/lib/credits/inference";
import { getActiveProSubscription } from "@/lib/billing/pro-subscription";
import { isDonkeySuperUser } from "@/lib/super-user";
import { normalizeAspect, type ProjectDoc } from "@/cut/lib/types";
import { ADOPT_COMMAND, type AdoptedAsset } from "@/cut/lib/commandBatch";
import { NO_CARD_OPEN, queueCommands, waitForJob, type CommandCall, type CommandJobResult, type JobRow } from "@/cut/server/cloud/commands";
import { needsWorker, queueDocExport, queueImportUrl } from "@/cut/server/cloud/jobs";
import { cutLimitsFor } from "@/cut/server/cloud/limits";
import { previewFromDoc } from "@/cut/server/cloud/previewJobs";
import { mediaObjectUrl, mediaUrlLifetime } from "@/cut/server/cloud/mediaCdn";
import { usageBytes } from "@/cut/server/cloud/usage";
import { wakeRenderWorker } from "@/cut/server/cloud/wake";
import type { ImportUrlResult } from "@/cut/worker/importUrlJob";
import type { Download, Editor, Playback, ProjectView } from "@/clients/chatgpt/contracts";
import { createEditorCode } from "@/clients/chatgpt/server/oauthTokens";
import type { ChatgptConfig } from "@/clients/chatgpt/server/config";
import { READ_COMMANDS, unknownCommandNames } from "@/clients/chatgpt/server/catalog";

type Identity = { userId: string; scopes: string[]; grantId: string };
export class ProjectToolError extends Error {}
export type ProjectResult = { view: ProjectView; playback: Playback | null; download?: Download | null; editor?: Editor | null };

/** A queue helper's refusal, read out of its Response as a message. */
async function refusalText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; bytes?: number; quotaBytes?: number };
  if (body.error === "storage_quota_exceeded")
    return `The account's cloud storage is full (${mb(body.bytes ?? 0)} of ${mb(body.quotaBytes ?? 0)} MB). Delete media or exports in Donkey Cut, or upgrade the plan.`;
  return body.error ?? "Donkey Cut refused the request.";
}

async function refusal(res: Response): Promise<never> {
  throw new ProjectToolError(await refusalText(res));
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

  /** The project view every edit tool answers with. */
  async function projectView(projectId: string): Promise<ProjectView> {
    return { ...emptyProjectView(), view: "project", project: await getOwnedProject(projectId) };
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
    if (row.kind === "import_url" && row.state === "done") return importView(row);
    if (row.kind === "commands" && row.state === "dismissed") throw new ProjectToolError(NO_CARD_OPEN);
    const view = await projectView(row.projectId);
    const status = jobStatus(row);
    view.job = { id: row.id, kind: row.kind, status, progress: Math.max(0, Math.min(1, row.progress)), ...(jobError(row) ? { error: jobError(row) } : {}) };
    if (row.kind !== "commands" && needsWorker(row)) wakeRenderWorker();
    if (status === "done" && row.kind === "commands") {
      const result = row.result as CommandJobResult | null;
      view.results = result?.results ?? [];
      view.changed = result?.changed ?? false;
    }
    return { view, playback: null };
  }

  /** A finished import as a result: its files become assets through a batch
   * the editor in the card runs, and the import counts as done once they have. */
  async function importView(row: JobRow): Promise<ProjectResult> {
    const adoption = await adoptImport(row);
    const view = await projectView(row.projectId!);
    view.results = [importOutcome(row, adoption)];
    view.changed = adoption.state === "adopted" && adoption.assets.length > 0;
    if (adoption.state === "pending") view.job = { id: row.id, kind: row.kind, status: "running", progress: 1 };
    if (adoption.state === "failed") view.job = { id: row.id, kind: row.kind, status: "error", progress: 1, error: adoption.error };
    return { view, playback: null };
  }

  type Adoption =
    | { state: "adopted"; assets: AdoptedAsset[] }
    | { state: "pending" }
    | { state: "failed"; error: string };

  /** What the import row remembers past the download: the batch adopting its
   * files, then the assets that batch landed. */
  type ImportRecord = ImportUrlResult & { adoptJobId?: string; assets?: AdoptedAsset[] };

  const importRecord = (row: JobRow) => (row.result ?? {}) as unknown as ImportRecord;

  async function rememberOnImport(row: JobRow, patch: Partial<ImportRecord>): Promise<void> {
    await db.cutRenderJob.updateMany({
      where: { id: row.id, userId: identity.userId },
      data: { result: { ...importRecord(row), ...patch } as unknown as Prisma.InputJsonValue },
    });
  }

  /** Queue the batch that adopts a finished import's files, once. A batch
   * dismissed because no card was open is queued again on the next poll. */
  async function adoptionBatch(row: JobRow, record: ImportRecord): Promise<{ id: string } | Response> {
    if (record.adoptJobId) {
      const previous = await db.cutRenderJob.findFirst({ where: { id: record.adoptJobId, userId: identity.userId }, select: { id: true, state: true } });
      if (previous && previous.state !== "dismissed") return { id: previous.id };
    }
    const files = record.files ?? [];
    const name = (row.spec as { name?: string } | null)?.name;
    const queued = await queueCommands(identity.userId, row.projectId!, {
      commands: [{ name: ADOPT_COMMAND, input: { files, ...(name ? { name } : {}) } }],
      label: `Imported ${files.map((f) => f.title || f.fileName).join(", ")}`,
    });
    if (!(queued instanceof Response)) await rememberOnImport(row, { adoptJobId: queued.id });
    return queued;
  }

  /** Turn a finished import's files into project assets, through a batch the
   * editor in the card runs. Once the batch lands, the assets are written
   * back to the import row and every poll after reads them from there. */
  async function adoptImport(row: JobRow): Promise<Adoption> {
    const record = importRecord(row);
    if (record.assets) return { state: "adopted", assets: record.assets };
    if (!record.files?.length || !row.projectId) return { state: "adopted", assets: [] };
    const queued = await adoptionBatch(row, record);
    if (queued instanceof Response) return { state: "failed", error: await refusalText(queued) };
    const batch = await waitForJob(identity.userId, queued.id, config.commandWaitMs, { editorClaimMs: config.editorClaimMs });
    if (!batch) return { state: "failed", error: "The import could not be added to the project." };
    if (batch.state === "queued" || batch.state === "running") return { state: "pending" };
    if (batch.state === "dismissed") return { state: "failed", error: NO_CARD_OPEN };
    const result = batch.result as CommandJobResult | null;
    const outcome = result?.results?.[0];
    if (batch.state !== "done" || !outcome?.ok)
      return { state: "failed", error: outcome?.error ?? jobError(batch) ?? "The import could not be added to the project." };
    const assets = (outcome.output as { assets?: AdoptedAsset[] } | null)?.assets ?? [];
    await rememberOnImport(row, { assets, ...(result?.docVersion ? { docVersion: result.docVersion } : {}) });
    return { state: "adopted", assets };
  }

  /** An import's line in the results, from where its adoption stands. */
  function importOutcome(row: JobRow, adoption: Adoption): ProjectView["results"][number] {
    const text = importRecord(row).text;
    const sourceText = text ? { sourceText: text } : {};
    switch (adoption.state) {
      case "adopted":
        return { name: "import_media", ok: true, output: { jobId: row.id, assets: adoption.assets, ...sourceText } };
      case "pending":
        return { name: "import_media", ok: true, output: { jobId: row.id, status: "running", detail: "The files are landing in the project. Poll get_job_status." } };
      case "failed":
        return { name: "import_media", ok: false, error: adoption.error };
    }
  }

  async function ownedJob(jobId: string): Promise<JobRow> {
    const row = await db.cutRenderJob.findFirst({ where: { id: jobId, userId: identity.userId } });
    if (!row) throw new ProjectToolError("Job not found.");
    return row;
  }

  /** Queue a batch for the editor in the card and wait on it within the
   * call's budget. */
  async function runBatch(projectId: string, commands: CommandCall[], opts: { readOnly?: boolean; label?: string }): Promise<ProjectResult> {
    await getOwnedProject(projectId);
    const unknown = unknownCommandNames(commands.map((c) => c.name));
    if (unknown.length)
      throw new ProjectToolError(`Unknown command${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Call list_commands for the catalog.`);
    const queued = await queueCommands(identity.userId, projectId, { commands, ...opts });
    if (queued instanceof Response) return refusal(queued);
    const row = await waitForJob(identity.userId, queued.id, config.commandWaitMs, { editorClaimMs: config.editorClaimMs });
    if (!row) throw new ProjectToolError("The job disappeared. Try again.");
    return jobView(row);
  }

  /** Undo or redo in the editor in the card: its history holds ChatGPT's
   * batches and the user's own edits as one line. */
  async function step(projectId: string, direction: "undo" | "redo"): Promise<ProjectResult> {
    requireEdit();
    return runBatch(projectId, [{ name: direction, input: {} }], { label: direction });
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
    /** A project card is the full editor, signed in through a one-use link,
     * whenever the connection can edit; a read-only one shows the preview. */
    async withEditor(result: ProjectResult): Promise<ProjectResult> {
      const projectId = result.view.project?.id;
      if (!canEdit || !projectId || result.editor) return result;
      const code = await createEditorCode(identity.grantId, db);
      const url = `${config.issuer}/api/chatgpt/embed?code=${code}&project=${encodeURIComponent(projectId)}`;
      return { ...result, editor: { url, expiresAt: Date.now() + 60_000 } };
    },
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
      return { view: { ...emptyProjectView(), view: "project", project: projectSummary(row) }, playback: null };
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
          ...(item.name ? { name: item.name } : {}),
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
      // Every import still downloading or still landing names its job, so
      // none is lost once the call returns; the first is the job the view
      // carries.
      const pending: JobRow[] = [];
      for (const row of rows) {
        if (row.state === "done") {
          const adoption = await adoptImport(row);
          view.results.push(importOutcome(row, adoption));
          if (adoption.state === "adopted" && adoption.assets.length > 0) view.changed = true;
          if (adoption.state === "pending") pending.push(row);
        } else if (row.state === "queued" || row.state === "running") {
          view.results.push({ name: "import_media", ok: true, output: { jobId: row.id, status: jobStatus(row) } });
          pending.push(row);
        } else {
          view.results.push({ name: "import_media", ok: false, error: jobError(row) ?? "The import failed." });
        }
      }
      if (pending.length) {
        const row = pending[0];
        view.job = { id: row.id, kind: row.kind, status: "running", progress: Math.max(0, Math.min(1, row.progress)) };
      }
      if (ids.length < items.length)
        view.results.push({ name: "import_media", ok: false, error: `${items.length - ids.length} item(s) were not queued: the account's job cap was reached.` });
      return { view, playback: null };
    },

    undo: (projectId: string) => step(projectId, "undo"),
    redo: (projectId: string) => step(projectId, "redo"),

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
