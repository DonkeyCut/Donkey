import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
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

type Identity = { userId: string; scopes: string[] };
export function createChatgptServer(
  identity: Identity,
  config: ChatgptConfig,
  projects = projectTools(identity, config),
) {
  const server = new McpServer({ name: "donkey-cut", version: "1.0.0" });
  const readMetadata = {
    securitySchemes: [{ type: "oauth2", scopes: ["projects:read"] }],
  };
  const renderMetadata = {
    securitySchemes: [
      { type: "oauth2", scopes: ["projects:read", "previews:render"] },
    ],
  };
  const runTool = async (run: () => Promise<ProjectResult>) => {
    try {
      const { view, playback } = await run();
      const text = describeProjectView(view);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: view,
        _meta: { playback, pollMs: config.pollMs },
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
      inputSchema: { cursor: idSchema.optional() },
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
      inputSchema: { projectId: idSchema.optional() },
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
      inputSchema: { projectId: idSchema },
      outputSchema: viewSchema,
      annotations: { ...readOnlyAnnotations, readOnlyHint: false },
      _meta: renderMetadata,
    },
    ({ projectId }) => {
      if (!identity.scopes.includes("previews:render")) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Reconnect Donkey Cut to allow preview rendering.",
            },
          ],
          _meta: {
            "mcp/www_authenticate": [
              `Bearer error="insufficient_scope", resource_metadata="${config.issuer}${RESOURCE_METADATA_PATH}", scope="projects:read previews:render"`,
            ],
          },
        };
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
      inputSchema: { projectId: idSchema, jobId: idSchema },
      outputSchema: viewSchema,
      annotations: readOnlyAnnotations,
      _meta: readMetadata,
    },
    ({ projectId, jobId }) => runTool(() => projects.status(projectId, jobId)),
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
              "Donkey Cut cloud project picker and video preview with render progress and an Open in Donkey Cut link.",
          },
        },
      ],
    }),
  );
  return server;
}

function describeProjectView(view: ProjectView): string {
  if (view.view === "projects") {
    if (!view.projects.length) {
      return "No cloud projects yet. Open Donkey Cut to save a project to the cloud.";
    }
    return view.projects
      .map((project) => `${project.name}: ${project.id} (${project.url})`)
      .join("\n");
  }

  const project = view.project!;
  const previewStatus = view.preview
    ? `preview ${view.preview.status}`
    : "no preview yet";
  return `${project.name}: ${previewStatus}. Open in Donkey Cut: ${project.url}`;
}

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
        "WWW-Authenticate": `Bearer resource_metadata="${config.issuer}${RESOURCE_METADATA_PATH}", scope="projects:read previews:render"`,
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

  const server = createChatgptServer(identity, config);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // Materialize the JSON response before closing this stateless request's transport.
    const body = await response.arrayBuffer();
    return new Response(body.byteLength ? body : null, {
      status: response.status,
      headers: {
        ...Object.fromEntries(response.headers),
        "Cache-Control": "no-store",
      },
    });
  } finally {
    await server.close();
  }
}
