import { prisma } from "@/lib/prisma";
import { previewFromDoc } from "@/cut/server/cloud/previewJobs";
import { mediaObjectUrl, mediaUrlLifetime } from "@/cut/server/cloud/mediaCdn";
import { wakeRenderWorker } from "@/cut/server/cloud/wake";
import type { Playback, ProjectView } from "@/clients/chatgpt/contracts";
import type { ChatgptConfig } from "@/clients/chatgpt/server/config";

type Identity = { userId: string; scopes: string[] };
export class ProjectToolError extends Error {}
export type ProjectResult = { view: ProjectView; playback: Playback | null };

export function projectTools(
  identity: Identity,
  config: ChatgptConfig,
  db = prisma,
) {
  const canRender = identity.scopes.includes("previews:render");
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
  });

  async function getOwnedProject(projectId: string) {
    const row = await db.cutProject.findFirst({
      where: { id: projectId, userId: identity.userId },
      select: { id: true, name: true, version: true },
    });
    if (!row) {
      throw new ProjectToolError(
        "Project not found. Choose one of your cloud projects.",
      );
    }
    return projectSummary(row);
  }

  async function getPreviewStatus(
    projectId: string,
    jobId?: string,
  ): Promise<ProjectResult> {
    const selectedProject = await getOwnedProject(projectId);
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

    const status =
      job.state === "queued" || job.state === "running" || job.state === "done"
        ? job.state
        : "error";
    view.preview = {
      id: job.id,
      status,
      progress: Math.max(0, Math.min(1, job.progress)),
      revision: (job.spec as { revision?: string } | null)?.revision ?? null,
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

  return {
    async list(cursor?: string): Promise<ProjectResult> {
      // A cursor names an account-owned row, so a foreign id cannot influence pagination.
      if (cursor) {
        await getOwnedProject(cursor);
      }
      const rows = await db.cutProject.findMany({
        where: { userId: identity.userId },
        select: { id: true, name: true, version: true },
        orderBy: { id: "asc" },
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
      const job = await previewFromDoc(identity.userId, projectId);
      if (!job) {
        throw new ProjectToolError(
          "Project not found. Choose one of your cloud projects.",
        );
      }
      return getPreviewStatus(projectId, job.id);
    },
  };
}
