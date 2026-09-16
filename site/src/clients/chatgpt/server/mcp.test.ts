import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { SETTINGS } from "@/lib/config/registry";
import {
  chatgptHttpHandler,
  createChatgptServer,
} from "@/clients/chatgpt/server/mcp";
import { WIDGET_URI } from "@/clients/chatgpt/contracts";
import type { projectTools, ProjectResult } from "@/clients/chatgpt/server/projects";
import { unknownCommandNames } from "@/clients/chatgpt/server/catalog";

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
    history: null,
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
    render: answer,
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
    ...overrides,
  };
};

describe("ChatGPT MCP protocol", () => {
  test("tools validate inputs, expose their safety annotations, and keep signed URLs out of model content", async () => {
    const server = createChatgptServer(
      { userId: "owner", scopes: ["projects:read", "previews:render"] },
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
          "describe_commands",
          "edit_project",
          "export_video",
          "get_export_status",
          "get_job_status",
          "get_preview_status",
          "import_media",
          "inspect_project",
          "list_commands",
          "list_projects",
          "list_skills",
          "open_project",
          "read_skill",
          "redo",
          "render_preview",
          "undo",
        ],
      );
      expect(tools.find((tool) => tool.name === "import_media")?._meta).toMatchObject({
        "openai/fileParams": ["files"],
      });
      expect(tools.find((tool) => tool.name === "edit_project")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
      expect(
        tools.find((tool) => tool.name === "render_preview")?.annotations,
      ).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
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
        ui: {
          csp: {
            resourceDomains: [config.issuer, "https://media.donkeycut.com"],
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("render scope requests a reconnect through the MCP authentication challenge", async () => {
  const server = createChatgptServer(
    { userId: "owner", scopes: ["projects:read"] },
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
      name: "edit_project",
      arguments: { projectId: "project", commands: [{ name: "set_aspect", input: { aspect: "9:16" } }] },
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
    { userId: "owner", scopes: ["projects:read"] },
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

test("edit results reach the model as text and structure, and captured frames become image blocks", async () => {
  const frame = "data:image/jpeg;base64,/9j/4AAQ";
  const edited: ProjectResult = {
    ...data,
    view: {
      ...data.view,
      changed: true,
      history: { undo: "Vertical cut", redo: null },
      results: [
        { name: "set_aspect", ok: true, output: { aspect: "9:16" } },
        { name: "capture_frame", ok: true, output: { image: frame, at: 1.5 } },
      ],
    },
    playback: null,
  };
  let received: unknown = null;
  const server = createChatgptServer(
    { userId: "owner", scopes: ["projects:read", "projects:write"] },
    config,
    fakeProjects({
      edit: async (_projectId, commands, label) => {
        received = { commands, label };
        return edited;
      },
    }),
  );
  const client = new Client({ name: "test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "edit_project",
      arguments: {
        projectId: "project",
        label: "Vertical cut",
        commands: [{ name: "set_aspect", input: { aspect: "9:16" } }, { name: "capture_frame" }],
      },
    });
    expect(received).toEqual({
      commands: [
        { name: "set_aspect", input: { aspect: "9:16" } },
        { name: "capture_frame", input: {} },
      ],
      label: "Vertical cut",
    });
    const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    expect(content[0].text).toContain("2 commands ran; the project was saved");
    expect(content[0].text).toContain("Undo would revert: Vertical cut");
    expect(content[0].text).not.toContain("base64");
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg", data: "/9j/4AAQ" });
    expect(JSON.stringify(result.structuredContent)).not.toContain("base64");

    const index = await client.callTool({ name: "list_commands", arguments: {} });
    const commands = (index.structuredContent as { commands: { name: string; reads?: true }[] }).commands;
    expect(commands.some((c) => c.name === "set_aspect")).toBe(true);
    expect(commands.find((c) => c.name === "watch_video")?.reads).toBe(true);
    expect(commands.some((c) => c.name === "get_state" || c.name === "undo" || c.name === "import_url")).toBe(false);
    // inspect_project's default read passes the batch guard while staying out of the listing.
    expect(unknownCommandNames(["get_state", "set_aspect", "nope"])).toEqual(["nope"]);

    const described = await client.callTool({ name: "describe_commands", arguments: { names: ["trim_clip", "nope"] } });
    expect(described.structuredContent).toMatchObject({ unknown: ["nope"] });
    expect((described.structuredContent as { commands: { name: string; inputSchema: object }[] }).commands[0].name).toBe("trim_clip");

    const skill = await client.callTool({ name: "read_skill", arguments: { name: "timeline-editing" } });
    expect((skill.content as { text: string }[])[0].text).toContain("# Timeline editing");
  } finally {
    await client.close();
    await server.close();
  }
});
