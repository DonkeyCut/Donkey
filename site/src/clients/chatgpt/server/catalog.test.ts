import { expect, test } from "bun:test";
import { AI_TOOLS, PROJECT_TOOLS } from "@/cut/server/ai/catalog";
import { COMMAND_NAMES, COMMANDS, READ_COMMANDS, SKILL_INDEX, commandEffectNote, commandHints, readSkill, unknownCommandNames, unmappedCommands } from "./catalog";
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
    expect(guide).toContain(name);
  }
  // Watching, listening and beat detection store what they find on the asset,
  // so only the pure measurements run as reads.
  for (const name of ["detect_silence", "measure_level", "read_color_stats", "capture_frame", "compare_to_source"]) {
    expect(READ_COMMANDS.has(name)).toBe(true);
  }
  expect(commandHints("watch_video")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  expect(commandHints("listen_audio")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  // A stored beat grid and a source note each replace what covered them.
  expect(commandHints("detect_beats")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  expect(commandHints("note_source")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  expect(guide).toContain("with note_source");
  expect(PROJECT_TOOLS.find((tool) => tool.name === "listen_audio")!.description).toContain("get_state");
  expect(COMMANDS.find((tool) => tool.name === "listen_audio")!.description).toContain("inspect_project");
});

test("every exposed command declares its effect, so its tool carries honest annotations", () => {
  expect(unmappedCommands()).toEqual([]);
  expect(COMMAND_NAMES).not.toContain("list_projects");
});

test("a command that moves or overwrites what is there is destructive", () => {
  // Placing slides the clips after the landing spot; a template, a replicated
  // edit or a designed text run takes over the frame or caption look.
  for (const name of ["add_clip", "add_overlay_video", "freeze_frame", "generate_image", "stock_add", "library_add", "template_use", "replicate_project", "add_text_sequence", "group_items", "subtitles_translate_track", "set_guides"]) {
    expect(commandHints(name).destructiveHint).toBe(true);
  }

  // Cut detection keeps a source's first picture box and overwrites nothing.
  expect(commandHints("detect_cuts")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  for (const name of ["add_title", "make_template", "voiceover_generate"]) {
    expect(commandHints(name).destructiveHint).toBe(false);
  }
});

test("every command's description states the effect its hints encode", () => {
  for (const name of COMMAND_NAMES) {
    expect(commandEffectNote(name).length).toBeGreaterThan(0);
  }
  expect(commandEffectNote("read_project")).toContain("changes nothing");
  expect(commandEffectNote("add_clip")).toContain("move");
});

test("nothing teaches the retired generic executor", () => {
  const text = [SERVER_INSTRUCTIONS, ...SKILL_INDEX.map((name) => readSkill(name)!), ...COMMANDS.map((tool) => tool.description)];
  for (const retired of ["edit_project", "list_commands", "describe_commands"]) {
    for (const t of text) expect(t).not.toContain(retired);
  }
});
