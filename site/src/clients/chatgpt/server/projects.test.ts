import { describe, expect, mock, test } from "bun:test";
import type { prisma } from "@/lib/prisma";
import { SETTINGS } from "@/lib/config/registry";
import { projectTools } from "@/clients/chatgpt/server/projects";

const config = SETTINGS.chatgptApp.schema.parse(SETTINGS.chatgptApp.default);
function createTestContext(scopes: string[] = ["projects:read"]) {
  const project = { id: "mine", userId: "owner", name: "My video", version: 4, previewKey: "proxy" };
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
    chatgptToken: {
      create: mock(async (args: { data: { hash: string; grantId: string; kind: string } }) => args.data),
    },
    cutMediaObject: {
      findFirst: mock(async (args: unknown) => {
        void args;
        return null as unknown;
      }),
    },
  };
  return {
    db,
    tools: projectTools(
      { userId: "owner", scopes, grantId: "grant" },
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
  test("read scope cannot enqueue renders or edits", async () => {
    const { tools } = createTestContext();
    await expect(tools.render("mine")).rejects.toThrow("permission");
    await expect(tools.edit("mine", [{ name: "set_aspect", input: { aspect: "9:16" } }])).rejects.toThrow("permission");
    await expect(tools.undo("mine")).rejects.toThrow("permission");
    await expect(tools.exportVideo("mine", "original")).rejects.toThrow("permission");
  });
  test("a batch names only catalog commands, and inspection stays read-only", async () => {
    const { tools } = createTestContext(["projects:read", "projects:write"]);
    await expect(tools.edit("mine", [{ name: "not_a_command", input: {} }])).rejects.toThrow("Unknown command: not_a_command");
    await expect(tools.edit("foreign", [{ name: "set_aspect", input: {} }])).rejects.toThrow("Project not found");
    await expect(tools.inspect("mine", [{ name: "set_aspect", input: { aspect: "9:16" } }])).rejects.toThrow("reads only");
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
  test("the editor's proxy is the current preview, so render plays it without queueing", async () => {
    const { tools, db } = createTestContext(["projects:read", "previews:render"]);
    db.cutRenderJob.findFirst.mockResolvedValue({ id: "job", state: "done", progress: 1, outputKey: "proxy", spec: { spec: {} }, updatedAt: new Date() });
    db.cutMediaObject.findFirst.mockResolvedValue({ r2Key: "proxy" });
    const opened = await tools.status("mine");
    expect(opened.view.preview?.revision).toBe("cloud:4");
    expect(opened.playback?.url).toContain("proxy");
    const rendered = await tools.render("mine");
    expect(rendered.view.preview?.id).toBe("job");
    expect(rendered.playback?.url).toContain("proxy");
  });
  test("opening a project with write scope carries a one-use editor link; read scope gets the preview", async () => {
    const readOnly = createTestContext();
    expect((await readOnly.tools.open("mine")).editor).toBeUndefined();
    expect(readOnly.db.chatgptToken.create).not.toHaveBeenCalled();
    const { tools, db } = createTestContext(["projects:read", "projects:write"]);
    const result = await tools.open("mine");
    expect(/^https:\/\/donkeycut\.com\/api\/chatgpt\/embed\?code=[A-Za-z0-9_-]{43}&project=mine$/.test(result.editor?.url ?? "")).toBe(true);
    expect(db.chatgptToken.create.mock.calls[0][0].data).toMatchObject({ grantId: "grant", kind: "embed" });
    expect(result.view.project?.id).toBe("mine");
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
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 21,
      select: { id: true, name: true, version: true },
    });
    expect(result.view.canRender).toBe(false);
  });
});
