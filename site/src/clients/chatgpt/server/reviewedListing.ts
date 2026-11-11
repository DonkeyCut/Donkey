import type { McpServer, StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server";
import reviewed from "@/clients/chatgpt/server/reviewedTools.json";

// ChatGPT sees the tool listing OpenAI reviewed, frozen in reviewedTools.json.
// Donkey's editor keeps evolving underneath: a call still runs today's
// command and validates against today's schema, which tests hold to a
// superset of the frozen one. The listing moves only when
// scripts/freeze-chatgpt-tools.ts writes a new snapshot under a new plugin
// version, and never while a version is in review.

/** Which listing a server advertises: the frozen snapshot, or the code as it
 * stands (the freeze script reads that one). */
export type ToolListing = "reviewed" | "live";

/** draft: frozen, not yet sent; submitted: OpenAI is reviewing this version;
 * settled: OpenAI answered, so the next freeze takes a new version. */
export type ReviewState = "draft" | "submitted" | "settled";

export type ReviewedTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
};

export const REVIEWED = reviewed as { version: string; review: ReviewState; tools: ReviewedTool[] };

type RegisterTool = McpServer["registerTool"];

/** A live schema that validates as itself and advertises the frozen JSON. */
function advertised(live: StandardSchemaWithJSON, json: Record<string, unknown>): StandardSchemaWithJSON {
  return { "~standard": { ...live["~standard"], jsonSchema: { input: () => json, output: () => json } } };
}

/** Make every tool the server registers from here on advertise its reviewed
 * metadata, and drop the ones the reviewed listing does not hold. */
export function serveListing(server: McpServer, listing: ToolListing): void {
  if (listing === "live") {
    return;
  }

  const byName = new Map(REVIEWED.tools.map((tool) => [tool.name, tool]));
  const register = server.registerTool.bind(server) as (...args: Parameters<RegisterTool>) => ReturnType<RegisterTool>;
  server.registerTool = ((...args: Parameters<RegisterTool>) => {
    const tool = register(...args);
    const frozen = byName.get(args[0]);

    // A command the editor gained after the freeze waits for the next one.
    if (!frozen) {
      tool.remove();
      return tool;
    }

    tool.update({
      ...(frozen.title !== undefined ? { title: frozen.title } : {}),
      ...(frozen.description !== undefined ? { description: frozen.description } : {}),
      ...(frozen.annotations ? { annotations: frozen.annotations } : {}),
      ...(tool.inputSchema ? { paramsSchema: advertised(tool.inputSchema, frozen.inputSchema) } : {}),
      ...(tool.outputSchema && frozen.outputSchema ? { outputSchema: advertised(tool.outputSchema, frozen.outputSchema) } : {}),
    });
    return tool;
  }) as RegisterTool;
}
