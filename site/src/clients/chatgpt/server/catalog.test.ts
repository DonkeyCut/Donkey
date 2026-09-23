import { expect, test } from "bun:test";
import { AI_TOOLS, PROJECT_TOOLS } from "@/cut/server/ai/catalog";
import { COMMANDS, READ_COMMANDS, SKILL_INDEX, readSkill } from "./catalog";

test("ChatGPT guides and command descriptions refer to available tools", () => {
  const available = new Set([
    ...COMMANDS.map((tool) => tool.name),
    "undo", "redo", "render_preview", "list_skills", "read_skill",
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
  expect(guide).toContain("edit_project with note_source");
  expect(PROJECT_TOOLS.find((tool) => tool.name === "listen_audio")!.description).toContain("get_state");
  expect(COMMANDS.find((tool) => tool.name === "listen_audio")!.description).toContain("inspect_project");
});
