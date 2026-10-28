import { expect, test } from "bun:test";
import { AI_TOOLS, PROJECT_TOOLS } from "@/cut/server/ai/catalog";
import { COMMAND_NAMES, COMMANDS, READ_COMMANDS, SKILL_INDEX, readSkill, unknownCommandNames, unmappedCommands } from "./catalog";
import { SERVER_INSTRUCTIONS } from "./mcp";

test("first-class history tools can queue their editor commands", () => {
  expect(COMMANDS.some((tool) => tool.name === "undo" || tool.name === "redo")).toBe(false);
  expect(unknownCommandNames(["undo", "redo", "not_a_command"])).toEqual(["not_a_command"]);
  expect(READ_COMMANDS.has("undo")).toBe(false);
  expect(READ_COMMANDS.has("redo")).toBe(false);
});

test("the editor's language setting stays out of ChatGPT's commands", () => {
  expect(COMMAND_NAMES).not.toContain("set_interface_language");
  expect(unknownCommandNames(["set_interface_language"])).toEqual(["set_interface_language"]);
});

test("a command that keeps a picture box on the source saves the document", () => {
  expect(READ_COMMANDS.has("detect_cuts")).toBe(false);
});

test("ChatGPT exposes file metadata as a read command", () => {
  expect(READ_COMMANDS.has("get_asset_info")).toBe(true);
  expect(COMMANDS.find((t) => t.name === "get_asset_info")?.inputSchema)
    .toBe(PROJECT_TOOLS.find((t) => t.name === "get_asset_info")?.inputSchema);
});

test("ChatGPT guides and command descriptions refer to available tools", () => {
  const available = new Set([
    ...COMMANDS.map((tool) => tool.name),
    "undo", "redo", "render_preview", "list_projects", "list_skills", "read_skill",
  ]);
  const unavailable = AI_TOOLS.filter((tool) => !available.has(tool.name));
  const guidance = [
    ...SKILL_INDEX.map((name) => readSkill(name)!),
    ...COMMANDS.map((tool) => JSON.stringify(tool)),
  ];
  for (const tool of unavailable) {
    const reference = new RegExp(`\\b${tool.name}\\b`);
    for (const text of guidance) expect(text).not.toMatch(reference);
  }
  expect(readSkill("scene-productions")).toBeUndefined();
  expect(readSkill("toString")).toBeUndefined();
  expect(readSkill("__proto__")).toBeUndefined();
});

test("ChatGPT preserves the shared inspection schemas and teaches their use", () => {
  const inspection = [
    "watch_video", "listen_audio", "detect_silence", "detect_beats",
    "measure_level", "read_color_stats", "capture_frame", "compare_to_source",
  ];
  const guide = readSkill("watching-and-cutting")!;
  for (const name of inspection) {
    const shared = PROJECT_TOOLS.find((tool) => tool.name === name)!;
    const command = COMMANDS.find((tool) => tool.name === name)!;
    expect(command.inputSchema).toBe(shared.inputSchema);
    expect(READ_COMMANDS.has(name)).toBe(true);
    expect(guide).toContain(name);
  }
  expect(READ_COMMANDS.has("note_source")).toBe(false);
  expect(guide).toContain("with note_source");
  expect(PROJECT_TOOLS.find((tool) => tool.name === "listen_audio")!.description).toContain("get_state");
  expect(COMMANDS.find((tool) => tool.name === "listen_audio")!.description).toContain("inspect_project");
});

test("every exposed command declares its effect, so its tool carries honest annotations", () => {
  expect(unmappedCommands()).toEqual([]);
  expect(COMMAND_NAMES).not.toContain("list_projects");
});

test("nothing teaches the retired generic executor", () => {
  const text = [SERVER_INSTRUCTIONS, ...SKILL_INDEX.map((name) => readSkill(name)!), ...COMMANDS.map((tool) => tool.description)];
  for (const retired of ["edit_project", "list_commands", "describe_commands"]) {
    for (const t of text) expect(t).not.toContain(retired);
  }
});
