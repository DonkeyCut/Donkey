import type { McpServer } from "@modelcontextprotocol/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";

// Installs and usage of the ChatGPT app: one ChatgptEvent row per approved
// connection and per tool call. scripts/chatgpt-usage.ts reads them back.

export type UsageEvent =
  | { kind: "connect"; userId: string }
  | { kind: "tool"; userId: string; tool: string; ok: boolean };

/** What a tool call came to, reported once the handler answers or throws. */
export type ToolCallSink = (tool: string, ok: boolean) => void;

type RegisterTool = McpServer["registerTool"];
type ToolHandler = (...args: unknown[]) => unknown;

/** Write one event. A failure is logged and goes no further: the connection
 * or call it describes has already happened. */
export async function recordEvent(event: UsageEvent, db = prisma): Promise<void> {
  try {
    await db.chatgptEvent.create({ data: event });
  } catch (error) {
    console.error("[chatgpt] usage event not recorded", {
      kind: event.kind,
      error: error instanceof Error ? error.name : "Unknown error",
    });
  }
}

/** Record an event after the response is sent, so it adds no latency. */
export function trackEvent(event: UsageEvent): void {
  // after() throws outside a request (a script, a test); write directly then.
  try {
    after(() => recordEvent(event));
  } catch {
    void recordEvent(event);
  }
}

/** Report every call to a tool the server registers from here on. */
export function reportToolCalls(server: McpServer, sink: ToolCallSink): void {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => ReturnType<RegisterTool>;
  server.registerTool = ((name: string, definition: unknown, handler: ToolHandler) =>
    register(name, definition, async (...args: unknown[]) => {
      try {
        const result = (await handler(...args)) as { isError?: boolean };
        sink(name, result.isError !== true);
        return result;
      } catch (error) {
        sink(name, false);
        throw error;
      }
    })) as unknown as RegisterTool;
}
