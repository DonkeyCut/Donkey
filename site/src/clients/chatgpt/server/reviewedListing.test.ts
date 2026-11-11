import { expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { COMMAND_NAMES, commandEffectNote, commandHints } from "@/clients/chatgpt/server/catalog";
import { createChatgptServer } from "@/clients/chatgpt/server/mcp";
import { REVIEWED, type ToolListing } from "@/clients/chatgpt/server/reviewedListing";
import { SETTINGS } from "@/lib/config/registry";

// ChatGPT reads the frozen listing while the editor keeps changing. These
// hold the two together: what ChatGPT reads is the snapshot, today's code
// still runs every call the snapshot teaches, and the snapshot's hints are
// today's effects.

const config = SETTINGS.chatgptApp.schema.parse({ ...SETTINGS.chatgptApp.default, enabled: true });

async function listTools(listing: ToolListing) {
  const server = createChatgptServer({ userId: "owner", scopes: ["projects:read", "projects:write", "previews:render"], grantId: "grant" }, config, undefined, undefined, listing);
  const client = new Client({ name: "test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

type Json = Record<string, unknown>;

/** Where a call the frozen schema allows would fail today's: a property
 * gone, an enum value dropped, a type changed, or a newly required field. */
function gaps(live: Json, frozen: Json, at: string, out: string[]): void {
  if (frozen.type !== undefined && live.type !== undefined && JSON.stringify(frozen.type) !== JSON.stringify(live.type)) {
    out.push(`${at}: type ${JSON.stringify(frozen.type)} is now ${JSON.stringify(live.type)}`);
  }

  // A frozen enum value has to stay accepted, e.g. a preset the listing teaches.
  const liveEnum = live.enum as unknown[] | undefined;
  for (const value of (frozen.enum as unknown[] | undefined) ?? []) {
    if (liveEnum && !liveEnum.includes(value)) {
      out.push(`${at}: ${JSON.stringify(value)} is no longer accepted`);
    }
  }

  const liveProps = (live.properties ?? {}) as Record<string, Json>;
  for (const [key, schema] of Object.entries((frozen.properties ?? {}) as Record<string, Json>)) {
    if (!(key in liveProps)) {
      out.push(`${at}.${key}: gone`);
      continue;
    }
    gaps(liveProps[key], schema, `${at}.${key}`, out);
  }
  for (const key of (live.required as string[] | undefined) ?? []) {
    if (!((frozen.required as string[] | undefined) ?? []).includes(key)) {
      out.push(`${at}: now requires ${key}`);
    }
  }
  if (live.items && frozen.items) {
    gaps(live.items as Json, frozen.items as Json, `${at}[]`, out);
  }
}

test("ChatGPT is served the reviewed listing, word for word", async () => {
  const served = await listTools("reviewed");
  expect(served.map((tool) => tool.name).sort()).toEqual(REVIEWED.tools.map((tool) => tool.name).sort());
  for (const frozen of REVIEWED.tools) {
    const tool = served.find((t) => t.name === frozen.name)!;
    expect({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations }).toEqual({
      name: frozen.name,
      title: frozen.title,
      description: frozen.description,
      inputSchema: frozen.inputSchema as typeof tool.inputSchema,
      outputSchema: frozen.outputSchema as typeof tool.outputSchema,
      annotations: frozen.annotations,
    });
  }
});

test("today's code runs every call the reviewed listing teaches", async () => {
  const live = new Map((await listTools("live")).map((tool) => [tool.name, tool]));
  const out: string[] = [];
  for (const frozen of REVIEWED.tools) {
    const tool = live.get(frozen.name);
    if (!tool) {
      out.push(`${frozen.name}: no longer exists`);
      continue;
    }
    gaps(tool.inputSchema as Json, frozen.inputSchema, frozen.name, out);

    // The answer is checked against today's output schema, so ChatGPT's copy
    // has to be that one.
    expect(tool.outputSchema).toEqual(frozen.outputSchema as typeof tool.outputSchema);
  }
  expect(out).toEqual([]);
});

test("the reviewed hints are today's effects, and each command states its own", () => {
  const commands = new Set(COMMAND_NAMES);
  for (const frozen of REVIEWED.tools.filter((tool) => commands.has(tool.name))) {
    expect(frozen.annotations).toEqual(commandHints(frozen.name));
    expect(frozen.description!.endsWith(commandEffectNote(frozen.name))).toBe(true);
  }
});

test("every reviewed tool sets each hint to true or false", () => {
  for (const frozen of REVIEWED.tools) {
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      expect(typeof frozen.annotations?.[hint]).toBe("boolean");
    }
    if (frozen.annotations?.readOnlyHint) {
      expect(frozen.annotations.destructiveHint).toBe(false);
    }
  }
});
