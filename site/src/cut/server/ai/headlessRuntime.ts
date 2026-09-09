import { spawn } from "node:child_process";
import path from "node:path";
import { chatRuntime } from "../../lib/chatRuntime";

type ToolResult = { output?: unknown; errorText?: string };
let idle: Promise<unknown> = Promise.resolve();

/** Next's development server uses Bun for the shared editor's client-marked modules. */
export function callDetachedTool(projectId: string, toolName: string, input: unknown): Promise<ToolResult> {
  if (process.versions.bun)
    return import("./headlessTools").then((module) => module.callHeadlessTool(projectId, toolName, input));
  const result = idle.then(() => new Promise<ToolResult>((resolve, reject) => {
    const child = spawn(path.join(process.cwd(), "node_modules", ".bin", "bun"), [
      path.join(process.cwd(), "src", "cut", "server", "ai", "headless-entry.ts"),
    ], { stdio: ["pipe", "ignore", "inherit", "pipe"], timeout: 120_000 });
    const output: Buffer[] = [];
    let bytes = 0;
    const channel = child.stdio[3];
    if (!channel || !("on" in channel)) { child.kill(); reject(new Error("Could not open the editor tool channel.")); return; }
    channel.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > chatRuntime().journalBytes) { child.kill(); reject(new Error("The editor tool result is too large.")); return; }
      output.push(data);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) { reject(new Error("The editor tool process stopped.")); return; }
      try { resolve(JSON.parse(Buffer.concat(output).toString()) as ToolResult); }
      catch { reject(new Error("The editor tool returned an invalid result.")); }
    });
    child.stdin!.on("error", reject);
    child.stdin!.end(JSON.stringify({ projectId, toolName, input }));
  }));
  idle = result.catch(() => {});
  return result;
}
