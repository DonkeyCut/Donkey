// The ChatGPT plugin package: the manifest, the MCP connection and the
// guides as skills, in the Agent Plugins layout OpenAI's portal imports from a
// ZIP. Tools come from the MCP server; this package carries the listing, the
// review cases and the skills.
import { SETTINGS } from "@/lib/config/registry";
import { CLIENT_ID, MCP_PATH, SCOPES } from "@/clients/chatgpt/server/config";
import { pluginSkills } from "@/clients/chatgpt/server/guidance";

/** The package name the portal gave the listing; uploads update it. */
const PACKAGE_NAME = "donkey-cut";
const SERVER_NAME = "donkey-cut";
const LOGO_SOURCE = "public/chatgpt-app-icon.png";
const LOGO = "./assets/logo.png";

const LONG_DESCRIPTION = `Donkey Cut is an open-source video editor.

Import footage, trim and arrange clips, add captions and titles, and preview your edits.

Open existing projects or start a new video, undo changes as you work, and export the finished result when you're ready.

Open Donkey Cut from the sidebar or beside a conversation to pick a project, or @-mention a project in the composer to work on it.`;

// Prompts the reviewer runs. Each names the tools ChatGPT should reach for, as
// one comma-separated string.
const POSITIVE = [
  {
    description: "Lists the account's cloud projects and opens the picker.",
    prompt: "Show me my Donkey Cut projects.",
    tools_triggered: "list_projects",
    expected_behavior: "Lists the connected account's cloud projects with their names, most recent first.",
  },
  {
    description: "Creates a vertical project and opens it in the editor card.",
    prompt: "Start a new vertical Donkey Cut video called Weekend recap.",
    tools_triggered: "create_project, open_project",
    expected_behavior: "Creates a 9:16 project named Weekend recap and shows the Donkey Cut editor in the card.",
  },
  {
    description: "Edits the open project with individual editing tools.",
    prompt: "In Donkey Cut, make my newest project square and add a title that says HELLO.",
    tools_triggered: "list_projects, open_project, set_aspect, add_title",
    expected_behavior: "Opens the project, sets the aspect to 1:1 and adds a HELLO title; the card shows both changes.",
  },
  {
    description: "Steps the card's undo history.",
    prompt: "Undo that last Donkey Cut edit.",
    tools_triggered: "undo",
    expected_behavior: "Reverts the most recent edit in the open project and says what changed.",
  },
  {
    description: "Exports the finished video for download.",
    prompt: "Export my Donkey Cut project as a video file.",
    tools_triggered: "export_video, get_export_status",
    expected_behavior: "Starts an export, reports progress, and returns a download link when it finishes.",
  },
];
const NEGATIVE = [
  { description: "General knowledge with no video editing.", prompt: "What is the capital of Australia?" },
  { description: "A writing task with no project or footage.", prompt: "Write a short poem about autumn leaves." },
  { description: "Arithmetic the model answers itself.", prompt: "What is 18 percent of 240?" },
];

type PluginFile = { path: string; text: string } | { path: string; from: string };

/** Every file in the package, with the logo copied from the site's assets.
 * The demo recording is the reviewer's video of the plugin at work. */
export function pluginFiles(demoRecordingUrl: string): PluginFile[] {
  const issuer = SETTINGS.chatgptApp.default.issuer;
  const skills = pluginSkills();
  const plugin = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: PACKAGE_NAME,
    version: "1.1.0",
    description: "Create and edit videos in Donkey Cut from ChatGPT.",
    author: { name: "HEY SALESMAN INC", url: issuer },
    homepage: issuer,
    repository: "https://github.com/DonkeyCut/Donkey",
    license: "Apache-2.0",
    extensions: {
      "com.openai": {
        onboardingSkill: "./skills/setup/SKILL.md",
        interface: {
          displayName: "Donkey Cut",
          shortDescription: "Create and edit videos",
          longDescription: LONG_DESCRIPTION,
          developerName: "HEY SALESMAN INC",
          category: "Creativity",
          websiteURL: issuer,
          supportURL: "https://discord.gg/Xv6qGax7sT",
          privacyPolicyURL: `${issuer}/privacy`,
          termsOfServiceURL: `${issuer}/terms`,
          defaultPrompt: [
            "Open my latest Donkey Cut project",
            "Start a vertical video for TikTok in Donkey Cut",
            "Add captions to my Donkey Cut project",
          ],
          logo: LOGO,
          composerIcon: LOGO,
        },
        review: {
          demo_recording_url: demoRecordingUrl,
          test_cases: { positive: POSITIVE, negative: NEGATIVE },
        },
      },
    },
  };
  const mcp = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      [SERVER_NAME]: {
        type: "streamable-http",
        url: `${issuer}${MCP_PATH}`,
        extensions: {
          "com.openai": {
            auth: { type: "oauth", client: { mode: "provided", clientId: CLIENT_ID, tokenEndpointAuthMethod: "none" }, defaultScopes: [...SCOPES] },
          },
        },
      },
    },
  };
  return [
    { path: "plugin.json", text: `${JSON.stringify(plugin, null, 2)}\n` },
    { path: "mcp.json", text: `${JSON.stringify(mcp, null, 2)}\n` },
    { path: "assets/logo.png", from: LOGO_SOURCE },
    // JSON strings are valid YAML scalars, so descriptions with colons stay intact.
    ...skills.map((skill) => ({
      path: `skills/${skill.name}/SKILL.md`,
      text: `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body.trim()}\n`,
    })),
  ];
}
