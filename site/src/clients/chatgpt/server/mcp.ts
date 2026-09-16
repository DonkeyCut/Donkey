import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  checkInMemoryRateLimit,
  rateLimitResponse,
} from "@/lib/inference/rate-limit";
import {
  viewSchema,
  WIDGET_URI,
  type ProjectView,
} from "@/clients/chatgpt/contracts";
import {
  commandIndex,
  COMMAND_NAMES,
  describeCommands,
  readSkill,
  SKILL_INDEX,
} from "@/clients/chatgpt/server/catalog";
import { MAX_COMMANDS_PER_BATCH } from "@/cut/server/cloud/commands";
import { DOC_EXPORT_PRESETS } from "@/cut/lib/exportPresets";
import {
  chatgptConfig,
  RESOURCE_METADATA_PATH,
  type ChatgptConfig,
} from "@/clients/chatgpt/server/config";
import { accessIdentity } from "@/clients/chatgpt/server/oauthTokens";
import {
  ProjectToolError,
  projectTools,
  type ProjectResult,
} from "@/clients/chatgpt/server/projects";
import { widgetHtml } from "@/clients/chatgpt/widget.generated";

const idSchema = z.string().min(1).max(128);
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
};
const editAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: false,
};

export const REPOSITORY_URL = "https://github.com/DonkeyCut/Donkey";

/** What ChatGPT reads before it picks a tool. The first 512 characters carry
 * the weight, so the economics and the workflow come first. */
export const SERVER_INSTRUCTIONS = [
  `Donkey Cut is an open-source video editor (Apache 2.0, ${REPOSITORY_URL}). Edit the connected account's cloud projects: import footage, inspect it, cut it, caption it, preview, undo, export.`,
  "Editing, previews and exports are free. Hosted AI (voiceover, music, images, caption rewriting, transcription past the monthly allowance) spends the account's credits. Imports and exports use the account's cloud storage.",
  "Workflow: list_projects or create_project → import_media → inspect_project → list_commands once, describe_commands for the ones you need → edit_project (batches, one undo step each) → render_preview → undo/redo → export_video.",
  "Times are seconds; ids come from inspect_project. A batch stops at its first failed command. A tool that answers with a job still running is finished by get_job_status.",
].join("\n");

const commandSchema = z.object({
  name: z.string().min(1).max(64).describe(`A command from list_commands: one of ${COMMAND_NAMES.join(", ")}`),
  input: z.record(z.string(), z.unknown()).optional().describe("The command's input, per describe_commands"),
});
/** A file ChatGPT attaches to a call (openai/fileParams). */
const fileSchema = z.object({
  download_url: z.url(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

type MediaBlock = { type: "image" | "audio"; data: string; mimeType: string };

/** Data-URL images and audio in a command's output become MCP image and
 * audio blocks, so base64 never lands in the text the model reads. */
function liftMedia(view: ProjectView): MediaBlock[] {
  const blocks: MediaBlock[] = [];
  const lift = (value: unknown): unknown => {
    const match = typeof value === "string" ? value.match(/^data:((image|audio)\/[a-z0-9.+-]+);base64,([\s\S]+)$/) : null;
    if (!match) return value;
    blocks.push({ type: match[2] as "image" | "audio", data: match[3], mimeType: match[1] });
    return `(${match[2]} ${blocks.length} attached)`;
  };
  for (const result of view.results) {
    const out = result.output as { image?: unknown; images?: unknown[]; audio?: unknown } | null;
    if (!out || typeof out !== "object") continue;
    if ("image" in out) out.image = lift(out.image);
    if (Array.isArray(out.images)) out.images = out.images.map(lift);
    if ("audio" in out) out.audio = lift(out.audio);
  }
  return blocks;
}

type Identity = { userId: string; scopes: string[] };
export function createChatgptServer(
  identity: Identity,
  config: ChatgptConfig,
  projects = projectTools(identity, config),
) {
  const server = new McpServer(
    { name: "donkey-cut", title: "Donkey Cut", version: "1.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const readMetadata = {
    securitySchemes: [{ type: "oauth2", scopes: ["projects:read"] }],
  };
  const renderMetadata = {
    securitySchemes: [
      { type: "oauth2", scopes: ["projects:read", "previews:render"] },
    ],
  };
  const editMetadata = {
    securitySchemes: [
      { type: "oauth2", scopes: ["projects:read", "projects:write"] },
    ],
  };
  const status = (invoking: string, invoked: string) => ({
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  });
  const scopeChallenge = (scope: string, text: string) => ({
    isError: true,
    content: [{ type: "text" as const, text }],
    _meta: {
      "mcp/www_authenticate": [
        `Bearer error="insufficient_scope", resource_metadata="${config.issuer}${RESOURCE_METADATA_PATH}", scope="projects:read previews:render projects:write"`,
      ],
      requiredScope: scope,
    },
  });
  const runTool = async (run: () => Promise<ProjectResult>) => {
    try {
      const { view, playback, download } = await run();
      const media = liftMedia(view);
      const text = describeProjectView(view);
      return {
        content: [{ type: "text" as const, text }, ...media],
        structuredContent: view,
        _meta: { playback, download: download ?? null, pollMs: config.pollMs },
      };
    } catch (error) {
      if (!(error instanceof ProjectToolError)) {
        console.error(
          "[chatgpt] project tool failed",
          error instanceof Error ? error.name : "Unknown error",
        );
      }
      const message =
        error instanceof ProjectToolError
          ? error.message
          : "Donkey Cut could not complete this request. Try again shortly.";
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  };

  server.registerTool(
    "list_projects",
    {
      title: "List Donkey Cut cloud projects",
      description:
        "List the connected user's saved cloud projects. Browser and Mac projects become available after being saved to the cloud. Follow nextCursor for more results.",
      inputSchema: z.object({ cursor: idSchema.optional() }),
      outputSchema: viewSchema,
      annotations: readOnlyAnnotations,
      _meta: readMetadata,
    },
    ({ cursor }) => runTool(() => projects.list(cursor)),
  );

  server.registerTool(
    "open_project",
    {
      title: "Open a Donkey Cut preview",
      description:
        "Show a selected cloud project and its latest available preview. The preview can be from an earlier edit; render_preview renders the current saved revision. With no projectId, show the project picker.",
      inputSchema: z.object({ projectId: idSchema.optional() }),
      outputSchema: viewSchema,
      annotations: readOnlyAnnotations,
      _meta: { ...readMetadata, ui: { resourceUri: WIDGET_URI } },
    },
    ({ projectId }) =>
      runTool(() => (projectId ? projects.status(projectId) : projects.list())),
  );

  server.registerTool(
    "render_preview",
    {
      title: "Render a Donkey Cut preview",
      description:
        "Render the current saved cloud project into a playable preview. Returns a job immediately; use get_preview_status to check it. Reuses a render of the same saved revision. Consumes no AI credits. Does not edit the project.",
      inputSchema: z.object({ projectId: idSchema }),
      outputSchema: viewSchema,
      annotations: { ...readOnlyAnnotations, readOnlyHint: false },
      _meta: renderMetadata,
    },
    ({ projectId }) => {
      if (!identity.scopes.includes("previews:render")) {
        return scopeChallenge("previews:render", "Reconnect Donkey Cut to allow preview rendering.");
      }
      return runTool(() => projects.render(projectId));
    },
  );

  server.registerTool(
    "get_preview_status",
    {
      title: "Check a Donkey Cut preview",
      description:
        "Read render progress or renew the playback URL of an existing preview. Returns expired when the preview needs rendering again.",
      inputSchema: z.object({ projectId: idSchema, jobId: idSchema }),
      outputSchema: viewSchema,
      annotations: readOnlyAnnotations,
      _meta: readMetadata,
    },
    ({ projectId, jobId }) => runTool(() => projects.status(projectId, jobId)),
  );

  const editing = <T,>(run: () => Promise<T>) =>
    identity.scopes.includes("projects:write")
      ? run()
      : Promise.resolve(scopeChallenge("projects:write", "Reconnect Donkey Cut to allow editing."));

  server.registerTool(
    "create_project",
    {
      title: "Create a Donkey Cut project",
      description:
        "Create an empty cloud project. aspect is the output frame as \"W:H\" — 9:16 for TikTok, Reels and Shorts, 16:9 for YouTube, 1:1 square (default 9:16). Free.",
      inputSchema: z.object({ name: z.string().min(1).max(120), aspect: z.string().max(16).optional() }),
      outputSchema: viewSchema,
      annotations: editAnnotations,
      _meta: { ...editMetadata, ...status("Creating the project", "Project created") },
    },
    ({ name, aspect }) => editing(() => runTool(() => projects.create(name, aspect))),
  );

  server.registerTool(
    "import_media",
    {
      title: "Import footage into a project",
      description:
        "Bring footage into a cloud project: files the user attached to the chat (files), or links (urls) — TikTok, YouTube, Instagram, an X post, a web page, or a direct video/audio/image link. Every file lands as a project asset with an assetId for edit_project's add_clip. Free; the bytes use the account's cloud storage. A long download can outlast this call — then the answer carries a job to finish with get_job_status. audio_only keeps just the soundtrack of a link.",
      inputSchema: z.object({
        projectId: idSchema,
        files: z.array(fileSchema).max(10).optional().describe("Files attached in ChatGPT"),
        urls: z.array(z.url()).max(10).optional().describe("Links to import"),
        audio_only: z.boolean().optional(),
      }),
      outputSchema: viewSchema,
      annotations: { ...editAnnotations, openWorldHint: true },
      _meta: { ...editMetadata, "openai/fileParams": ["files"], ...status("Importing footage", "Footage imported") },
    },
    ({ projectId, files, urls, audio_only }) =>
      editing(() =>
        runTool(() => {
          const items = [
            ...(files ?? []).map((f) => ({ url: f.download_url, ...(f.file_name ? { name: f.file_name } : {}) })),
            ...(urls ?? []).map((url) => ({ url })),
          ];
          if (!items.length) throw new ProjectToolError("Attach files or pass urls.");
          return projects.importMedia(projectId, items, audio_only === true);
        }),
      ),
  );

  server.registerTool(
    "inspect_project",
    {
      title: "Inspect a project",
      description:
        "Read a project's full editor state — media assets with ids, durations, transcripts and notes; the video tracks with clip ids, trims and gaps; soundtrack, titles, captions, aspect. Call it before editing and after an edit_project you want to verify. Pass commands to run read-only inspection commands instead (watch_video for contact sheets of the footage, capture_frame for the composited picture at a time, detect_silence, listen_audio, detect_beats — list_commands marks them reads). Free.",
      inputSchema: z.object({
        projectId: idSchema,
        commands: z.array(commandSchema).max(MAX_COMMANDS_PER_BATCH).optional(),
      }),
      outputSchema: viewSchema,
      annotations: readOnlyAnnotations,
      _meta: { ...readMetadata, ...status("Reading the project", "Project read") },
    },
    ({ projectId, commands }) => runTool(() => projects.inspect(projectId, commands?.map((c) => ({ name: c.name, input: c.input ?? {} })))),
  );

  server.registerTool(
    "list_commands",
    {
      title: "List editing commands",
      description:
        "The catalog of editing commands edit_project runs, one line each. Call it once per conversation, then describe_commands for the input schemas of the ones you will use.",
      inputSchema: z.object({}),
      outputSchema: z.object({ commands: z.array(z.object({ name: z.string(), summary: z.string(), reads: z.literal(true).optional() })) }),
      annotations: readOnlyAnnotations,
      _meta: { ...readMetadata, ...status("Listing commands", "Commands listed") },
    },
    () => {
      const commands = commandIndex();
      return {
        content: [{ type: "text" as const, text: commands.map((c) => `${c.name}${c.reads ? " (read)" : ""}: ${c.summary}`).join("\n") }],
        structuredContent: { commands },
      };
    },
  );

  server.registerTool(
    "describe_commands",
    {
      title: "Describe editing commands",
      description: "Full descriptions and JSON input schemas for named commands from list_commands.",
      inputSchema: z.object({ names: z.array(z.string().min(1).max(64)).min(1).max(20) }),
      outputSchema: z.object({
        commands: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) })),
        unknown: z.array(z.string()),
      }),
      annotations: readOnlyAnnotations,
      _meta: { ...readMetadata, ...status("Describing commands", "Commands described") },
    },
    ({ names }) => {
      const { found, unknown } = describeCommands(names);
      const commands = found.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ commands, unknown }) }],
        structuredContent: { commands, unknown },
      };
    },
  );

  server.registerTool(
    "list_skills",
    {
      title: "List editing guides",
      description: "The editor's own guides — timeline editing, watching and cutting by content, captions, transitions, graphics, audio, export. Read one with read_skill before working in an unfamiliar area.",
      inputSchema: z.object({}),
      outputSchema: z.object({ skills: z.array(z.string()) }),
      annotations: readOnlyAnnotations,
      _meta: { ...readMetadata, ...status("Listing guides", "Guides listed") },
    },
    () => ({
      content: [{ type: "text" as const, text: SKILL_INDEX.join("\n") }],
      structuredContent: { skills: SKILL_INDEX },
    }),
  );

  server.registerTool(
    "read_skill",
    {
      title: "Read an editing guide",
      description: "Read one guide from list_skills.",
      inputSchema: z.object({ name: z.string().min(1).max(64) }),
      annotations: readOnlyAnnotations,
      _meta: { ...readMetadata, ...status("Reading the guide", "Guide read") },
    },
    ({ name }) => {
      const doc = readSkill(name);
      if (!doc) return { isError: true, content: [{ type: "text" as const, text: `No such guide. Available: ${SKILL_INDEX.join(", ")}` }] };
      return { content: [{ type: "text" as const, text: doc }] };
    },
  );

  server.registerTool(
    "edit_project",
    {
      title: "Edit a project",
      description:
        "Run editing commands on a cloud project, in order, as one undo step. Commands come from list_commands with inputs per describe_commands; ids and times come from inspect_project. The batch stops at the first command that fails and reports every outcome. label names the step for undo. Editing is free; commands that generate media (voiceover_generate, generate_music, generate_image, captions_generate) spend the account's credits. The result's history says what undo would revert.",
      inputSchema: z.object({
        projectId: idSchema,
        commands: z.array(commandSchema).min(1).max(MAX_COMMANDS_PER_BATCH),
        label: z.string().max(80).optional().describe("What this step does, e.g. \"Cut to 30s and add captions\""),
      }),
      outputSchema: viewSchema,
      annotations: editAnnotations,
      _meta: { ...editMetadata, ...status("Editing the project", "Project edited") },
    },
    ({ projectId, commands, label }) =>
      editing(() => runTool(() => projects.edit(projectId, commands.map((c) => ({ name: c.name, input: c.input ?? {} })), label))),
  );

  server.registerTool(
    "undo",
    {
      title: "Undo the last edit",
      description: "Revert the last edit_project or import_media step on a project. Steps saved from the Donkey Cut editor itself are not on this history.",
      inputSchema: z.object({ projectId: idSchema }),
      outputSchema: viewSchema,
      annotations: editAnnotations,
      _meta: { ...editMetadata, ...status("Undoing", "Undone") },
    },
    ({ projectId }) => editing(() => runTool(() => projects.undo(projectId))),
  );

  server.registerTool(
    "redo",
    {
      title: "Redo an undone edit",
      description: "Re-apply the step the last undo reverted.",
      inputSchema: z.object({ projectId: idSchema }),
      outputSchema: viewSchema,
      annotations: editAnnotations,
      _meta: { ...editMetadata, ...status("Redoing", "Redone") },
    },
    ({ projectId }) => editing(() => runTool(() => projects.redo(projectId))),
  );

  server.registerTool(
    "export_video",
    {
      title: "Export a project",
      description:
        `Render the saved project to an MP4 the user downloads from the Donkey Cut card. preset: ${DOC_EXPORT_PRESETS.join(" | ")} (original matches the footage; tiktok is best quality 1080p; fast is a smaller 1080p; light is a 720p draft). Free; the file counts against the account's cloud storage and is listed in the project's Media panel. A render can outlast this call — finish it with get_export_status.`,
      inputSchema: z.object({ projectId: idSchema, preset: z.enum(DOC_EXPORT_PRESETS).optional() }),
      outputSchema: viewSchema,
      annotations: editAnnotations,
      _meta: { ...editMetadata, ...status("Exporting the video", "Export started") },
    },
    ({ projectId, preset }) => editing(() => runTool(() => projects.exportVideo(projectId, preset ?? "original"))),
  );

  server.registerTool(
    "get_export_status",
    {
      title: "Check an export",
      description: "Read an export's progress; when it is done the Donkey Cut card offers the download.",
      inputSchema: z.object({ jobId: idSchema }),
      outputSchema: viewSchema,
      annotations: readOnlyAnnotations,
      _meta: { ...readMetadata, ...status("Checking the export", "Export checked") },
    },
    ({ jobId }) => runTool(() => projects.exportStatus(jobId)),
  );

  server.registerTool(
    "get_job_status",
    {
      title: "Check a job",
      description: "Finish a call that answered with a running job (an import, an edit batch, an export): read its progress and, once done, its results.",
      inputSchema: z.object({ jobId: idSchema }),
      outputSchema: viewSchema,
      annotations: readOnlyAnnotations,
      _meta: { ...readMetadata, ...status("Checking the job", "Job checked") },
    },
    ({ jobId }) => runTool(() => projects.jobStatus(jobId)),
  );

  server.registerTool(
    "account_status",
    {
      title: "Account credits and storage",
      description: "The connected account's AI credit balance, cloud storage used against its allowance, and plan. Editing, previews and exports never spend credits.",
      inputSchema: z.object({}),
      outputSchema: viewSchema,
      annotations: readOnlyAnnotations,
      _meta: { ...readMetadata, ...status("Reading the account", "Account read") },
    },
    () => runTool(() => projects.account()),
  );

  server.registerResource(
    "project-preview",
    WIDGET_URI,
    { mimeType: "text/html;profile=mcp-app" },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: "text/html;profile=mcp-app",
          text: widgetHtml(config.issuer),
          _meta: {
            ui: {
              prefersBorder: true,
              domain: "https://chatgpt.donkeycut.com",
              csp: {
                connectDomains: ["https://media.donkeycut.com"],
                resourceDomains: [config.issuer, "https://media.donkeycut.com"],
              },
            },
            "openai/widgetDescription":
              "Donkey Cut cloud project picker and video preview with render progress, export download, and an Open in Donkey Cut link.",
          },
        },
      ],
    }),
  );
  return server;
}

function describeProjectView(view: ProjectView): string {
  if (view.account) {
    const { credits, storageBytes, storageQuotaBytes, plan } = view.account;
    const storage = storageQuotaBytes === null ? `${mb(storageBytes)} MB used` : `${mb(storageBytes)} of ${mb(storageQuotaBytes)} MB used`;
    return `Plan: ${plan}. AI credits: $${credits}. Cloud storage: ${storage}. Editing, previews and exports spend no credits.`;
  }
  if (view.view === "projects") {
    if (!view.projects.length) {
      return "No cloud projects yet. Create one with create_project, or open Donkey Cut to save a project to the cloud.";
    }
    return view.projects
      .map((project) => `${project.name}: ${project.id} (${project.url})`)
      .join("\n");
  }

  const project = view.project!;
  const lines: string[] = [];
  if (view.job && view.job.status !== "done") {
    lines.push(
      view.job.status === "error"
        ? `Job ${view.job.id} (${view.job.kind}) failed: ${view.job.error ?? "unknown error"}.`
        : `Job ${view.job.id} (${view.job.kind}) is ${view.job.status} at ${Math.round(view.job.progress * 100)}%. Call get_job_status with this id to finish.`,
    );
  }
  if (view.results.length) {
    const failed = view.results.filter((r) => !r.ok);
    lines.push(
      `${view.results.length} command${view.results.length === 1 ? "" : "s"} ran${failed.length ? `, ${failed.length} failed` : ""}${view.changed ? "; the project was saved" : "; nothing changed"}.`,
    );
    lines.push(JSON.stringify(view.results));
  }
  if (view.export) {
    const { status, progress, name, error } = view.export;
    lines.push(
      status === "done"
        ? `Export ${name ?? ""} is ready: the Donkey Cut card has the Download button, and the file is in the project's Media panel.`
        : status === "error" || status === "expired"
          ? `Export ${name ?? ""} ${status}: ${error ?? ""}`
          : `Export ${name ?? ""} is ${status} at ${Math.round(progress * 100)}%. Call get_export_status with job id ${view.export.id}.`,
    );
  }
  if (view.preview || !lines.length) {
    lines.push(`${project.name} (${project.revision}): ${view.preview ? `preview ${view.preview.status}` : "no preview yet"}.`);
  }
  if (view.history?.undo) lines.push(`Undo would revert: ${view.history.undo}.`);
  if (view.history?.redo) lines.push(`Redo would re-apply: ${view.history.redo}.`);
  lines.push(`Open in Donkey Cut: ${project.url}`);
  return lines.join("\n");
}

const mb = (bytes: number) => Math.round(bytes / 1024 ** 2);

/** POST /api/chatgpt/mcp: this protocol accepts scoped OAuth access tokens. */
export async function mcpEndpoint(request: Request) {
  const config = await chatgptConfig();
  if (!config.enabled) {
    return new Response("ChatGPT connection is not enabled.", { status: 503 });
  }
  // ChatGPT's server-to-server transport has no Origin. Browser callers use the app bridge.
  const origin = request.headers.get("origin");
  if (origin && origin !== config.issuer) {
    return new Response("Forbidden", { status: 403 });
  }

  const authorizationHeader = request.headers.get("authorization");
  const identity =
    authorizationHeader && /^Bearer /i.test(authorizationHeader)
      ? await accessIdentity(authorizationHeader.slice(7), config)
      : null;
  if (!identity || !identity.scopes.includes("projects:read")) {
    return new Response(null, {
      status: identity ? 403 : 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${config.issuer}${RESOURCE_METADATA_PATH}", scope="projects:read previews:render projects:write"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const rateLimit = checkInMemoryRateLimit({
    key: `chatgpt:mcp:${identity.userId}`,
    limit: config.requestsPerMinute,
    windowMs: 60000,
  });
  if (!rateLimit.ok) {
    return rateLimitResponse(rateLimit.retryAfterSeconds);
  }

  const handler = chatgptHttpHandler(identity, config);
  try {
    const response = await handler.fetch(request);
    // Materialize the body before closing the per-request handler.
    const body = await response.arrayBuffer();
    return new Response(body.byteLength ? body : null, {
      status: response.status,
      headers: {
        ...Object.fromEntries(response.headers),
        "Cache-Control": "no-store",
      },
    });
  } finally {
    await handler.close();
  }
}

/**
 * Serves protocol 2026-07-28 requests directly and answers 2025-era clients
 * through the stateless initialize path, so a ChatGPT connection works
 * whichever revision it sends. Every request gets a fresh server.
 */
export function chatgptHttpHandler(
  identity: Identity,
  config: ChatgptConfig,
  projects?: ReturnType<typeof projectTools>,
) {
  return createMcpHandler(
    () => createChatgptServer(identity, config, projects),
    {
      onerror: (error) =>
        console.warn("[chatgpt] mcp request rejected", error.message),
    },
  );
}
