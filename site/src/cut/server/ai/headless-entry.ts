import { writeSync } from "node:fs";
import { callHeadlessTool } from "./headlessTools";

// A separate result channel leaves tool diagnostics on stderr.
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const { projectId, toolName, input } = JSON.parse(Buffer.concat(chunks).toString()) as {
  projectId: string; toolName: string; input: unknown;
};
let result: { output?: unknown; errorText?: string };
try { result = await callHeadlessTool(projectId, toolName, input); }
catch (error) { result = { errorText: error instanceof Error ? error.message : String(error) }; }
writeSync(3, JSON.stringify(result));
