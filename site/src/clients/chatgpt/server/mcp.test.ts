import { describe, expect, test } from "bun:test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SETTINGS } from "@/lib/config/registry";
import { createChatgptServer } from "@/clients/chatgpt/server/mcp";
import { WIDGET_URI } from "@/clients/chatgpt/contracts";
import type { ProjectResult } from "@/clients/chatgpt/server/projects";

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
  },
  playback: {
    url: "https://media.donkeycut.com/object?private=token",
    expiresAt: Date.now() + 3600000,
  },
};

describe("ChatGPT MCP protocol", () => {
  test("tools validate inputs, expose their safety annotations, and keep signed URLs out of model content", async () => {
    const server = createChatgptServer(
      { userId: "owner", scopes: ["projects:read", "previews:render"] },
      config,
      {
        list: async () => data,
        status: async () => data,
        render: async () => data,
      },
    );
    const client = new Client({ name: "test", version: "1" });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(4);
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
    {
      list: async () => data,
      status: async () => data,
      render: async () => {
        throw new Error("must not render without scope");
      },
    },
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
  } finally {
    await client.close();
    await server.close();
  }
});

test("stateless HTTP initializes and serves independent tool requests", async () => {
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
  ]) {
    const server = createChatgptServer(
      { userId: "owner", scopes: ["projects:read"] },
      config,
      {
        list: async () => data,
        status: async () => data,
        render: async () => data,
      },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(
        new Request(`${config.issuer}/api/chatgpt/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(message),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.id).toBe(message.id);
      if (message.method === "tools/call") {
        expect(body.result.structuredContent).toEqual(data.view);
      }
    } finally {
      await server.close();
    }
  }
});
