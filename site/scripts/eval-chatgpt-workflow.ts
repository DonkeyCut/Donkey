#!/usr/bin/env bun
/**
 * The ChatGPT editing workflow, end to end: drive the MCP server in process
 * as the dev-bypass account and walk the milestone — create a project, import
 * footage, inspect it, make a vertical cut, preview, undo, redo, export — and
 * assert every step landed in the stored document and the export downloads.
 *
 * Every batch runs in the editor open in the ChatGPT card, so this script
 * stands that card in: it opens the project in the same editor store the page
 * uses, claims batches through the card's routes, runs them through the
 * headless executors, saves through the versioned PUT and reports back.
 *
 * Run with the site dev server up and a local worker running:
 *   bun run scripts/eval-chatgpt-workflow.ts [--base http://localhost:3000] [--keep]
 * (worker: `npm run worker:build && node dist/cut-worker/main.js` from site/;
 * .env supplies DATABASE_URL and the R2 credentials for both)
 */

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { SETTINGS } from "../src/lib/config/registry";
import { createChatgptServer, SERVER_INSTRUCTIONS } from "../src/clients/chatgpt/server/mcp";
import type { ProjectView } from "../src/clients/chatgpt/contracts";
import { runCommandBatch, type CommandJobSpec } from "../src/cut/lib/commandBatch";
import { bindHeadlessSession, type HeadlessSession } from "../src/cut/lib/headless/bind";
import { openCloudProject, pushCloudProject } from "../src/cut/lib/headless/docSession";
import { headlessDeps } from "../src/cut/lib/pi/serverDeps";
import { serializeDoc, useEditor } from "../src/cut/lib/store";
import { deleteProjectCascade } from "../src/cut/server/cloud/projects";
import { prisma } from "../src/lib/prisma";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const base = arg("base") ?? "http://localhost:3000";
const keep = process.argv.includes("--keep");
// The user the dev bypass header resolves to (src/lib/donkey-api-auth.ts).
const USER_ID = "donkey-dev-auth-bypass";
const FOOTAGE = `${base}/cut-starter/media/ai-watercolor-and-loose-black-ink-sketch-il.mp4`;

const fail = (msg: string): never => {
  process.exitCode = 1;
  throw new Error(`FAIL ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const config = SETTINGS.chatgptApp.schema.parse({ ...SETTINGS.chatgptApp.default, enabled: true, commandWaitMs: 120_000 });
const server = createChatgptServer(
  { userId: USER_ID, scopes: ["projects:read", "previews:render", "projects:write"], grantId: "eval" },
  config
);
const client = new Client({ name: "eval", version: "1" });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

type Called = { view: ProjectView; text: string; images: number; isError?: boolean };
async function call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as { type: string; text?: string }[];
  const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (result.isError) fail(`${name}: ${text}`);
  return { view: result.structuredContent as ProjectView, text, images: content.filter((c) => c.type === "image").length };
}

/** Poll a job the call handed back until it settles. */
async function settle(first: Called, tool: "get_job_status" | "get_export_status", label: string): Promise<Called> {
  let current = first;
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const job = tool === "get_export_status" ? current.view.export : current.view.job;
    if (!job || (job.status !== "queued" && job.status !== "running")) return current;
    if (Date.now() > deadline) fail(`${label} did not settle in 10 minutes — is the worker running?`);
    console.log(`  ${label}: ${job.status} ${Math.round(job.progress * 100)}%`);
    await sleep(2000);
    current = await call(tool, { jobId: job.id });
  }
}

/** The card, stood in for: claim the project's batches and run them on the
 * open document until the signal ends it. */
async function hostCard(projectId: string, signal: AbortSignal): Promise<void> {
  const session: HeadlessSession = { base, headers: { "x-donkey-client-id": "eval-card", "x-donkey-dev-auth-bypass": "1" } };
  bindHeadlessSession(session);
  const deps = headlessDeps(session);
  const open = await openCloudProject(session, projectId);
  const api = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { ...session.headers, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const snapshot = () => JSON.stringify(serializeDoc(useEditor.getState()));
  while (!signal.aborted) {
    const res = await api(`/api/cut-cloud/projects/${projectId}/commands/claim`);
    if (res.status !== 200) { await sleep(300); continue; }
    const { id, spec } = (await res.json()) as { id: string; spec: CommandJobSpec };
    let report: unknown;
    try {
      const before = snapshot();
      if (!spec.readOnly) useEditor.getState().beginHistoryBatch();
      let results;
      try {
        results = await runCommandBatch(projectId, spec.commands, (name, input) => deps.execTool(name, input));
      } finally {
        if (!spec.readOnly) useEditor.getState().endHistoryBatch();
      }
      const changed = !spec.readOnly && snapshot() !== before;
      if (changed) await pushCloudProject(session, open);
      report = { ok: true, results, changed, docVersion: changed ? open.version : null };
    } catch (error) {
      report = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    await api(`/api/cut-cloud/jobs/${id}/result`, report);
  }
}

const doc = async (projectId: string) => {
  const row = await prisma.cutProject.findFirst({ where: { id: projectId, userId: USER_ID }, select: { doc: true, version: true } });
  if (!row) fail("project row is gone");
  return { ...(row!.doc as { aspect?: string; clips?: { id: string; in: number; out: number }[]; overlays?: { text?: string }[]; assets?: { id: string }[] }), version: row!.version };
};

let projectId: string | null = null;
const card = new AbortController();
let hosting: Promise<void> | undefined;
try {
  // Instructions and catalog: what ChatGPT reads first.
  if (!SERVER_INSTRUCTIONS.includes("github.com/DonkeyCut/Donkey")) fail("server instructions do not link the repository");
  const index = await call("list_commands");
  const names = (index.view as unknown as { commands: { name: string }[] }).commands.map((c) => c.name);
  for (const need of ["set_aspect", "add_clip", "trim_clip", "add_title", "subtitles_generate", "set_framing"])
    if (!names.includes(need)) fail(`list_commands misses ${need}`);
  console.log(`catalog: ${names.length} commands`);

  const created = await call("create_project", { name: `chatgpt-workflow-${Date.now()}`, aspect: "16:9" });
  projectId = created.view.project?.id ?? fail("create_project returned no project");
  console.log(`created ${projectId}`);

  // An edit before the card is open is refused, and says so.
  const closed = await client.callTool({ name: "edit_project", arguments: { projectId, commands: [{ name: "set_aspect", input: { aspect: "9:16" } }] } });
  if (!closed.isError || !JSON.stringify(closed.content).includes("open_project")) fail(`an edit with no card open should ask for open_project: ${JSON.stringify(closed.content)}`);
  console.log("no card open: the edit asks for open_project");
  hosting = hostCard(projectId, card.signal).catch((e) => { if (!card.signal.aborted) console.error("card failed:", e); });

  const imported = await settle(await call("import_media", { projectId, urls: [FOOTAGE] }), "get_job_status", "import");
  const importAssets = imported.view.results.flatMap((r) => ((r.output as { assets?: { assetId: string; name: string; duration: number }[] })?.assets ?? []));
  if (!importAssets.length) fail(`import landed no asset: ${imported.text}`);
  const asset = importAssets[0];
  console.log(`imported asset ${asset.assetId} "${asset.name}" (${asset.duration}s)`);

  const inspected = await call("inspect_project", { projectId });
  const state = inspected.view.results[0]?.output as { media?: unknown[] } | undefined;
  if (!state || !Array.isArray(state.media) || state.media.length !== 1) fail(`inspect_project state has no media list: ${inspected.text.slice(0, 200)}`);
  console.log("inspected: state carries the footage");

  const before = await doc(projectId);
  const placed = await settle(
    await call("edit_project", {
      projectId,
      label: "Vertical frame with the footage",
      commands: [
        { name: "set_aspect", input: { aspect: "9:16" } },
        { name: "add_clip", input: { asset_id: asset.assetId } },
      ],
    }),
    "get_job_status",
    "edit"
  );
  if (placed.view.results.some((r) => !r.ok)) fail(`the first batch failed: ${placed.text}`);
  const clipId = (placed.view.results[1].output as { id?: string })?.id ?? fail("add_clip returned no clip id");
  const after = await doc(projectId);
  if (after.aspect !== "9:16") fail(`aspect did not save: ${after.aspect}`);
  if (!(after.clips?.length === 1)) fail(`clip did not save: ${JSON.stringify(after.clips)}`);
  if (after.version <= before.version) fail("the edit did not bump the version");

  // A batch stops at its first failure and reports how far it got.
  const broken = await settle(
    await call("edit_project", {
      projectId,
      commands: [{ name: "trim_clip", input: { clipId: "no-such-clip", out: 1 } }, { name: "set_background", input: { color: "#ff0000" } }],
    }),
    "get_job_status",
    "broken edit"
  );
  if (broken.view.results.length !== 1 || broken.view.results[0].ok || broken.view.changed) fail(`a failed batch should stop and save nothing: ${broken.text}`);

  const finished = await settle(
    await call("edit_project", {
      projectId,
      label: "Trim and title",
      commands: [
        { name: "trim_clip", input: { clipId, in: 0, out: Math.min(3, asset.duration) } },
        { name: "add_title", input: { text: "MADE IN CHATGPT", start: 0, end: 2 } },
        { name: "capture_frame", input: { t: 0.5 } },
      ],
    }),
    "get_job_status",
    "edit 2"
  );
  if (finished.view.results.some((r) => !r.ok)) fail(`second batch failed: ${finished.text}`);
  if (finished.images < 1) fail("capture_frame returned no image block");
  const titled = await doc(projectId);
  if (!(titled.overlays ?? []).some((o) => o.text === "MADE IN CHATGPT")) fail("the title did not save");
  if (!(titled.clips![0].out - titled.clips![0].in <= 3.001)) fail("the trim did not save");
  console.log("edited: aspect, clip, trim, title and a captured frame");

  const undone = await call("undo", { projectId });
  if (!undone.view.changed) fail(`undo changed nothing: ${undone.text}`);
  const reverted = await doc(projectId);
  if ((reverted.overlays ?? []).some((o) => o.text === "MADE IN CHATGPT")) fail("undo left the title in place");
  const redone = await call("redo", { projectId });
  if (!redone.view.changed) fail(`redo changed nothing: ${redone.text}`);
  const restored = await doc(projectId);
  if (!(restored.overlays ?? []).some((o) => o.text === "MADE IN CHATGPT")) fail("redo did not bring the title back");
  console.log("undo and redo step the card's history");

  const previewed = await call("render_preview", { projectId });
  if (!previewed.view.preview) fail("render_preview queued nothing");
  console.log(`preview ${previewed.view.preview.status}`);

  const exported = await settle(await call("export_video", { projectId, preset: "light" }), "get_export_status", "export");
  if (exported.view.export?.status !== "done") fail(`export ended ${exported.view.export?.status}: ${exported.view.export?.error ?? exported.text}`);
  const meta = (await client.callTool({ name: "get_export_status", arguments: { jobId: exported.view.export.id } }))._meta as { download?: { url: string; name: string } };
  if (!meta.download?.url) fail("no download in the export result metadata");
  const head = await fetch(meta.download.url, { method: "HEAD" });
  if (!head.ok) fail(`the export download answered ${head.status}`);
  console.log(`PASS exported ${meta.download.name} (${head.headers.get("content-length")} bytes)`);
} finally {
  card.abort();
  await hosting?.catch(() => {});
  await client.close().catch(() => {});
  await server.close().catch(() => {});
  if (projectId && !keep) await deleteProjectCascade(USER_ID, projectId).catch((e) => console.error("cleanup failed:", e));
  await prisma.$disconnect().catch(() => {});
}
