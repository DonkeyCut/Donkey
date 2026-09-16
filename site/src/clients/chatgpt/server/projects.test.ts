import { describe, expect, mock, test } from "bun:test";
import type { prisma } from "@/lib/prisma";
import { SETTINGS } from "@/lib/config/registry";
import { projectTools } from "@/clients/chatgpt/server/projects";

const config = SETTINGS.chatgptApp.schema.parse(SETTINGS.chatgptApp.default);
function createTestContext() {
  const project = { id: "mine", userId: "owner", name: "My video", version: 4 };
  const jobs = mock(async (args: unknown) => {
    void args;
    return null as unknown;
  });
  const db = {
    cutProject: {
      findFirst: mock(
        async ({ where }: { where: { id: string; userId: string } }) =>
          where.id === project.id && where.userId === project.userId
            ? project
            : null,
      ),
      findMany: mock(async (args: unknown) => {
        void args;
        return [project];
      }),
    },
    cutRenderJob: { findFirst: jobs },
    cutMediaObject: {
      findFirst: mock(async (args: unknown) => {
        void args;
        return null;
      }),
    },
  };
  return {
    db,
    tools: projectTools(
      { userId: "owner", scopes: ["projects:read"] },
      config,
      db as unknown as typeof prisma,
    ),
  };
}

describe("ChatGPT cloud projects", () => {
  test("foreign projects and cursors fail before reading previews or listing", async () => {
    const { tools, db } = createTestContext();
    await expect(tools.status("foreign", "preview")).rejects.toThrow(
      "Project not found",
    );
    await expect(tools.list("foreign")).rejects.toThrow("Project not found");
    expect(db.cutRenderJob.findFirst).not.toHaveBeenCalled();
    expect(db.cutProject.findMany).not.toHaveBeenCalled();
  });
  test("read scope cannot enqueue renders", async () => {
    const { tools } = createTestContext();
    await expect(tools.render("mine")).rejects.toThrow("permission");
  });
  test("status is constrained to the owner, selected project, and preview kind", async () => {
    const { tools, db } = createTestContext();
    await expect(tools.status("mine", "foreign-job")).rejects.toThrow(
      "Preview not found",
    );
    expect(db.cutRenderJob.findFirst.mock.calls[0][0]).toMatchObject({
      where: {
        userId: "owner",
        projectId: "mine",
        kind: "preview",
        id: "foreign-job",
      },
    });
  });
  test("collected artifacts are reported as expired with no playback URL", async () => {
    const { tools, db } = createTestContext();
    db.cutRenderJob.findFirst.mockResolvedValue({
      id: "job",
      state: "done",
      progress: 1,
      outputKey: "old-preview",
      spec: { revision: "cloud:3" },
    });
    const result = await tools.status("mine", "job");
    expect(result.view.preview?.status).toBe("expired");
    expect(result.playback).toBeNull();
    expect(result.view.project?.revision).toBe("cloud:4");
  });
  test("list returns only public project metadata and paging state", async () => {
    const { tools, db } = createTestContext();
    const result = await tools.list();
    expect(result.view.projects).toEqual([
      {
        id: "mine",
        name: "My video",
        revision: "cloud:4",
        url: "https://donkeycut.com/app/p/mine",
      },
    ]);
    expect(db.cutProject.findMany.mock.calls[0][0]).toMatchObject({
      where: { userId: "owner" },
      take: 21,
      select: { id: true, name: true, version: true },
    });
    expect(result.view.canRender).toBe(false);
  });
});
