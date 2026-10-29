import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { SETTINGS } from "@/lib/config/registry";
import {
  chatgptHttpHandler,
  createChatgptServer,
} from "@/clients/chatgpt/server/mcp";
import { WIDGET_URI } from "@/clients/chatgpt/contracts";
import type { projectTools, ProjectResult } from "@/clients/chatgpt/server/projects";
import { COMMAND_NAMES, unknownCommandNames } from "@/clients/chatgpt/server/catalog";

const config = SETTINGS.chatgptApp.schema.parse({
  ...SETTINGS.chatgptApp.default,
  enabled: true,
});
const project = {
  id: "project",
  name: "Project",
  revision: "cloud:2",
  url: "https://donkeycut.com/app/p/project",
};
const data: ProjectResult = {
  view: {
    view: "project",
    projects: [],
    nextCursor: null,
    project,
    preview: {
      id: "preview",
      status: "done",
      progress: 1,
      revision: "cloud:2",
    },
    canRender: true,
    canEdit: true,
    export: null,
    job: null,
    results: [],
    changed: false,
    account: null,
  },
  playback: {
    url: "https://media.donkeycut.com/object?private=token",
    expiresAt: Date.now() + 3600000,
  },
};
type Projects = ReturnType<typeof projectTools>;
/** Every project tool answers with `data` unless overridden. */
const fakeProjects = (overrides: Partial<Projects> = {}): Projects => {
  const answer = async () => data;
  return {
    list: answer,
    status: answer,
    open: answer,
    render: answer,
    withEditor: async (result: ProjectResult) => result,
    create: answer,
    inspect: answer,
    edit: answer,
    importMedia: answer,
    undo: answer,
    redo: answer,
    exportVideo: answer,
    exportStatus: answer,
    jobStatus: answer,
    account: answer,
    search: async () => [{ id: "project", name: "Launch cut", revision: "cloud:1", url: "https://donkeycut.com/app/p/project" }],
    ...overrides,
  };
};

describe("ChatGPT MCP protocol", () => {
  test("tools validate inputs, expose their safety annotations, and keep signed URLs out of model content", async () => {
    const server = createChatgptServer(
      { userId: "owner", scopes: ["projects:read", "previews:render"], grantId: "grant" },
      config,
      fakeProjects(),
    );
    const client = new Client({ name: "test", version: "1" });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [
          "account_status",
          "create_project",
          "export_video",
          "find_projects",
          "get_export_status",
          "get_job_status",
          "get_preview_status",
          "import_media",
          "inspect_project",
          "list_projects",
          "list_skills",
          "open_project",
          "read_skill",
          "redo",
          "render_preview",
          "undo",
          ...COMMAND_NAMES,
        ].sort(),
      );

      // OpenAI's review needs every hint set explicitly, a read never
      // destructive, and each operation its own tool with its own schema.
      for (const tool of tools) {
        const hints = tool.annotations!;
        for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
          expect(typeof hints[hint]).toBe("boolean");
        }
        if (hints.readOnlyHint) {
          expect(hints.destructiveHint).toBe(false);
        }
        expect(tool.description!.length).toBeGreaterThan(0);
        expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"commands"/);
      }
      for (const name of ["delete_item", "delete_asset", "set_color_grade", "undo", "redo"]) {
        expect(tools.find((tool) => tool.name === name)?.annotations?.destructiveHint).toBe(true);
      }
      expect(tools.find((tool) => tool.name === "check_facts")?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      expect(tools.find((tool) => tool.name === "library_share")?.annotations).toMatchObject({ openWorldHint: true, destructiveHint: true });
      expect(tools.find((tool) => tool.name === "add_title")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tools.find((tool) => tool.name === "trim_clip")?.inputSchema.required).toContain("projectId");
      expect(tools.find((tool) => tool.name === "import_media")?._meta).toMatchObject({
        "openai/fileParams": ["files"],
      });
      expect(tools.find((tool) => tool.name === "import_media")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      });
      expect(
        tools.find((tool) => tool.name === "render_preview")?.annotations,
      ).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
      // The sidebar and thread panel open the picker; the composer's @-menu
      // searches projects through an app-only read.
      expect(tools.find((tool) => tool.name === "open_project")?._meta).toMatchObject({
        "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
      });
      expect(tools.find((tool) => tool.name === "open_project")?.icons).toEqual([
        { src: `${config.issuer}/chatgpt-entry.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
      ]);
      expect(client.getServerCapabilities()?.extensions).toEqual({ "openai/mentions": { searchTool: "find_projects" } });
      expect(tools.find((tool) => tool.name === "find_projects")?._meta).toMatchObject({ ui: { visibility: ["app"] } });
      const mentions = await client.callTool({ name: "find_projects", arguments: { query: "launch" } });
      expect(mentions.structuredContent).toEqual({
        items: [{ type: "resource_link", uri: "https://donkeycut.com/app/p/project", name: "Launch cut", mimeType: "text/html" }],
      });
      const picker = await client.callTool({ name: "open_project", arguments: {} });
      expect(picker.isError).toBeFalsy();

      const result = await client.callTool({
        name: "open_project",
        arguments: { projectId: "project" },
      });
      expect(result.structuredContent).toEqual(data.view);
      expect(JSON.stringify(result.content)).not.toContain("private=token");
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        "private=token",
      );
      expect(result._meta).toMatchObject({ playback: data.playback });
      const invalid = await client.callTool({
        name: "get_preview_status",
        arguments: { projectId: "project" },
      });
      expect(invalid.isError).toBe(true);
      const resource = await client.readResource({ uri: WIDGET_URI });
      expect(resource.contents[0].mimeType).toBe("text/html;profile=mcp-app");
      expect(resource.contents[0]._meta).toMatchObject({
        "openai/ui": { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "inline" },
        ui: {
          csp: {
            resourceDomains: [config.issuer, "https://media.donkeycut.com"],
            frameDomains: [config.issuer],
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("open_project answers a deleted project as a typed view the card can read", async () => {
  const missing: ProjectResult = { view: { ...data.view, view: "missing", project: null, preview: null, missing: { id: "gone" } }, playback: null };
  const server = createChatgptServer(
    { userId: "owner", scopes: ["projects:read", "projects:write"], grantId: "grant" },
    config,
    fakeProjects({ open: async () => missing }),
  );
  const client = new Client({ name: "test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "open_project", arguments: { projectId: "gone" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(missing.view);
    expect(JSON.stringify(result.content)).toContain("no longer exists");
    expect(result._meta).toMatchObject({ editor: null });
  } finally {
    await client.close();
    await server.close();
  }
});

test("render scope requests a reconnect through the MCP authentication challenge", async () => {
  const server = createChatgptServer(
    { userId: "owner", scopes: ["projects:read"], grantId: "grant" },
    config,
    fakeProjects({
      render: async () => {
        throw new Error("must not render without scope");
      },
      edit: async () => {
        throw new Error("must not edit without scope");
      },
    }),
  );
  const client = new Client({ name: "test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "render_preview",
      arguments: { projectId: "project" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result._meta)).toContain("insufficient_scope");
    const edit = await client.callTool({
      name: "set_aspect",
      arguments: { projectId: "project", aspect: "9:16" },
    });
    expect(edit.isError).toBe(true);
    expect(JSON.stringify(edit._meta)).toContain("projects:write");
  } finally {
    await client.close();
    await server.close();
  }
});

const projects = fakeProjects();
const http = async (
  message: Record<string, unknown>,
  headers: Record<string, string> = {},
) => {
  const handler = chatgptHttpHandler(
    { userId: "owner", scopes: ["projects:read"], grantId: "grant" },
    config,
    projects,
  );
  try {
    return await handler.fetch(
      new Request(`${config.issuer}/api/chatgpt/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify(message),
      }),
    );
  } finally {
    await handler.close();
  }
};
/** Legacy stateless serving answers over SSE; the final event carries the response. */
const readBody = async (response: Response) => {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));
  return events.at(-1);
};
type RpcBody = {
  id?: unknown;
  result: {
    structuredContent?: unknown;
    resources?: { uri: string; mimeType?: string }[];
    contents?: { uri: string; mimeType?: string; text?: string }[];
  };
};
const expectServed = async (body: RpcBody, method: string) => {
  if (method === "tools/call") {
    expect(body.result.structuredContent).toEqual(data.view);
  }
  if (method === "resources/list") {
    expect(
      body.result.resources?.some(
        (resource) =>
          resource.uri === WIDGET_URI &&
          resource.mimeType === "text/html;profile=mcp-app",
      ),
    ).toBe(true);
  }
  if (method === "resources/read") {
    expect(body.result.contents).toHaveLength(1);
    expect(body.result.contents?.[0]).toMatchObject({
      uri: WIDGET_URI,
      mimeType: "text/html;profile=mcp-app",
    });
    expect(body.result.contents?.[0].text).toContain("<!doctype html>");
    expect(body.result.contents?.[0].text).toContain(
      `${config.issuer}/clients/chatgpt/`,
    );
  }
};

test("protocol 2026-07-28 requests are served without a handshake", async () => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "chatgpt", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  for (const [method, params, name] of [
    ["tools/list", {}, undefined],
    [
      "tools/call",
      { name: "open_project", arguments: { projectId: "project" } },
      "open_project",
    ],
    ["resources/list", {}, undefined],
    ["resources/read", { uri: WIDGET_URI }, WIDGET_URI],
  ] as const) {
    const response = await http(
      { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } },
      {
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(name ? { "Mcp-Name": name } : {}),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await readBody(response);
    expect(body.id).toBe(1);
    await expectServed(body, method);
  }
});

test("2025-era clients still initialize and read tools and widget resources statelessly", async () => {
  for (const message of [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "open_project", arguments: { projectId: "project" } },
    },
    { jsonrpc: "2.0", id: 3, method: "resources/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: WIDGET_URI },
    },
  ]) {
    const response = await http(message, {
      "MCP-Protocol-Version": "2025-11-25",
    });
    expect(response.status).toBe(200);
    const body = await readBody(response);
    expect(body.id).toBe(message.id);
    await expectServed(body, message.method);
  }
});

test("each command is its own tool: writes edit, reads inspect, and captured frames become image blocks", async () => {
  const frame = "data:image/jpeg;base64,/9j/4AAQ";
  const edited: ProjectResult = {
    ...data,
    view: { ...data.view, changed: true, results: [{ name: "set_aspect", ok: true, output: { aspect: "9:16" } }] },
    playback: null,
  };
  const captured: ProjectResult = {
    ...data,
    view: { ...data.view, results: [{ name: "capture_frame", ok: true, output: { image: frame, at: 1.5 } }] },
    playback: null,
  };
  const received: unknown[] = [];
  const server = createChatgptServer(
    { userId: "owner", scopes: ["projects:read", "projects:write"], grantId: "grant" },
    config,
    fakeProjects({
      edit: async (projectId, commands) => {
        received.push({ edit: projectId, commands });
        return edited;
      },
      inspect: async (projectId, commands) => {
        received.push({ inspect: projectId, commands });
        return captured;
      },
    }),
  );
  const client = new Client({ name: "test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const write = await client.callTool({ name: "set_aspect", arguments: { projectId: "project", aspect: "9:16" } });
    expect((write.content as { text: string }[])[0].text).toContain("1 command ran; the project was saved");

    const read = await client.callTool({ name: "capture_frame", arguments: { projectId: "project", t: 1.5 } });
    expect(received).toEqual([
      { edit: "project", commands: [{ name: "set_aspect", input: { aspect: "9:16" } }] },
      { inspect: "project", commands: [{ name: "capture_frame", input: { t: 1.5 } }] },
    ]);
    const content = read.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    expect(content[0].text).not.toContain("base64");
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg", data: "/9j/4AAQ" });
    expect(JSON.stringify(read.structuredContent)).not.toContain("base64");

    // A schema violation never reaches the project.
    const invalid = await client.callTool({ name: "set_aspect", arguments: { projectId: "project", nope: 1 } });
    expect(invalid.isError).toBe(true);
    expect(received).toHaveLength(2);
    // inspect_project's default read passes the batch guard.
    expect(unknownCommandNames(["get_state", "set_aspect", "nope"])).toEqual(["nope"]);

    const skill = await client.callTool({ name: "read_skill", arguments: { name: "timeline-editing" } });
    expect((skill.content as { text: string }[])[0].text).toContain("# Timeline editing");

    const skills = await client.callTool({ name: "list_skills", arguments: {} });
    const names = (skills.structuredContent as { skills: string[] }).skills;
    expect(names).toContain("watching-and-cutting");
    expect(names).not.toContain("scene-productions");
    const unavailable = await client.callTool({ name: "read_skill", arguments: { name: "scene-productions" } });
    expect(unavailable.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});
