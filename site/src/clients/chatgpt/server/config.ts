import { prisma } from "@/lib/prisma";
import { resolveSettings } from "@/lib/config/resolve";

export const CLIENT_ID = "donkey-chatgpt";
export const SCOPES = ["projects:read", "previews:render"] as const;
export const MCP_PATH = "/api/chatgpt/mcp";
export const OAUTH_PATH = "/api/chatgpt/oauth";
export const RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/api/chatgpt/mcp";

export async function chatgptConfig() {
  const override = await prisma.settingOverride.findUnique({
    where: { key: "chatgptApp" },
    select: { value: true },
  });
  const overrides = override ? { chatgptApp: override.value } : {};
  const { settings } = resolveSettings(overrides, []);
  return settings.chatgptApp;
}

export type ChatgptConfig = Awaited<ReturnType<typeof chatgptConfig>>;

export function resourceUrl(config: ChatgptConfig) {
  return `${config.issuer}${MCP_PATH}`;
}
