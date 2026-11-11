import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createChatgptServer } from "../src/clients/chatgpt/server/mcp";
import { REVIEWED, type ReviewedTool, type ReviewState } from "../src/clients/chatgpt/server/reviewedListing";
import { SETTINGS } from "../src/lib/config/registry";

// The ChatGPT tool listing OpenAI reviews, frozen so the editor can keep
// changing underneath it.
//   npx bun scripts/freeze-chatgpt-tools.ts freeze   snapshot today's tools
//   npx bun scripts/freeze-chatgpt-tools.ts submit   the snapshot went to OpenAI
//   npx bun scripts/freeze-chatgpt-tools.ts settle   OpenAI answered
// A freeze after a settled review takes the next patch version, so a changed
// listing always reaches OpenAI as a new plugin version.

type Step = "freeze" | "submit" | "settle";
const STEPS: Step[] = ["freeze", "submit", "settle"];
const step = process.argv[2] as Step;
if (!STEPS.includes(step)) {
  throw new Error(`Pass one of: ${STEPS.join(", ")}.`);
}

const file = path.resolve(import.meta.dir, "../src/clients/chatgpt/server/reviewedTools.json");
const save = async (version: string, review: ReviewState, tools: ReviewedTool[]) => {
  await writeFile(file, `${JSON.stringify({ version, review, tools }, null, 2)}\n`);
  console.log(`ChatGPT listing ${version}: ${review}, ${tools.length} tools.`);
};

// Marking the review moves the state alone; the listing stays as frozen.
if (step === "submit") {
  if (REVIEWED.review !== "draft") {
    throw new Error(`Version ${REVIEWED.version} is ${REVIEWED.review}; freeze a draft first.`);
  }
  await save(REVIEWED.version, "submitted", REVIEWED.tools);
  process.exit(0);
}
if (step === "settle") {
  if (REVIEWED.review !== "submitted") {
    throw new Error(`Version ${REVIEWED.version} is ${REVIEWED.review}, not in review.`);
  }
  await save(REVIEWED.version, "settled", REVIEWED.tools);
  process.exit(0);
}

// The reviewer tests what production serves, so the listing holds still
// until OpenAI answers.
if (REVIEWED.review === "submitted") {
  throw new Error(`Version ${REVIEWED.version} is in review. Run settle once OpenAI answers, then freeze.`);
}

// Read the listing the code serves today, as ChatGPT would.
const config = SETTINGS.chatgptApp.schema.parse({ ...SETTINGS.chatgptApp.default, enabled: true });
const server = createChatgptServer({ userId: "freeze", scopes: [], grantId: "freeze" }, config, undefined, undefined, "live");
const client = new Client({ name: "freeze", version: "1" });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
const { tools } = await client.listTools();
await client.close();

// Only what OpenAI judges goes in: names, words, schemas and hints.
const frozen: ReviewedTool[] = tools
  .map((tool) => ({
    name: tool.name,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema as Record<string, unknown>,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// A draft nobody has sent keeps its version; a settled one takes the next.
const [major, minor, patch] = REVIEWED.version.split(".").map(Number);
const version = REVIEWED.review === "draft" ? REVIEWED.version : `${major}.${minor}.${patch + 1}`;
await save(version, "draft", frozen);
