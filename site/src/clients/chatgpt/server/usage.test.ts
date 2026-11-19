import { expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { SETTINGS } from "@/lib/config/registry";
import { createChatgptServer } from "@/clients/chatgpt/server/mcp";
import type { projectTools } from "@/clients/chatgpt/server/projects";
import { recordEvent } from "@/clients/chatgpt/server/usage";
import type { prisma } from "@/lib/prisma";

const config = SETTINGS.chatgptApp.schema.parse({ ...SETTINGS.chatgptApp.default, enabled: true });

test("every tool call is reported with its outcome", async () => {
  const calls: [string, boolean][] = [];
  const server = createChatgptServer(
    { userId: "owner", scopes: ["projects:read"], grantId: "grant" },
    config,
    {} as ReturnType<typeof projectTools>,
    undefined,
    "reviewed",
    (tool, ok) => calls.push([tool, ok]),
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  try {
    await client.callTool({ name: "list_skills", arguments: {} });
    await client.callTool({ name: "read_skill", arguments: { name: "no-such-guide" } });
    // A write without the write scope answers a scope challenge.
    await client.callTool({ name: "create_project", arguments: { name: "Cut" } });
    // The card polls this on a timer; a poll is no one's use of the app.
    await client.callTool({ name: "get_preview_status", arguments: { projectId: "p", jobId: "j" } });
  } finally {
    await client.close();
    await server.close();
  }

  expect(calls).toEqual([
    ["list_skills", true],
    ["read_skill", false],
    ["create_project", false],
  ]);
});

test("a failed write never reaches the caller", async () => {
  const db = { chatgptEvent: { create: async () => { throw new Error("no table"); } } } as unknown as typeof prisma;
  expect(await recordEvent({ kind: "connect", userId: "owner" }, db)).toBeUndefined();
});
