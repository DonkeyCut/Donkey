import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { pluginFiles } from "./plugin";

const DEMO = "https://example.com/demo.mp4";
const files = pluginFiles(DEMO);
const json = (name: string) => {
  const file = files.find((f) => f.path === name);
  if (!file || !("text" in file)) throw new Error(`missing ${name}`);
  return JSON.parse(file.text);
};

// The portal's limits for an initial MCP review, checked before an upload.
test("the manifest fits the portal's listing and review limits", () => {
  const openai = json("plugin.json").extensions["com.openai"];
  const ui = openai.interface;
  expect(ui.displayName.length).toBeLessThanOrEqual(30);
  expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
  expect(ui.longDescription.length).toBeLessThanOrEqual(4000);
  expect(ui.developerName.length).toBeLessThanOrEqual(80);
  for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    expect(ui[key].startsWith("https://")).toBe(true);
  }
  expect(ui.defaultPrompt.length).toBeLessThanOrEqual(3);
  expect(new Set(ui.defaultPrompt).size).toBe(ui.defaultPrompt.length);
  for (const prompt of ui.defaultPrompt) {
    expect(prompt.length).toBeLessThanOrEqual(128);
    expect(prompt).not.toContain("@");
  }
  expect(openai.review.demo_recording_url).toBe(DEMO);
  expect(openai.review.test_cases.positive).toHaveLength(5);
  expect(openai.review.test_cases.negative).toHaveLength(3);
  for (const c of openai.review.test_cases.positive) {
    expect(c.tools_triggered.length).toBeGreaterThan(0);
    expect(c.expected_behavior.length).toBeGreaterThan(0);
  }
});

test("every path the manifest names ships in the package, and no secret does", () => {
  const openai = json("plugin.json").extensions["com.openai"];
  const paths = new Set(files.map((f) => `./${f.path}`));
  for (const ref of [openai.onboardingSkill, openai.interface.logo, openai.interface.composerIcon]) {
    expect(paths.has(ref)).toBe(true);
  }
  for (const file of files) {
    if ("from" in file) expect(existsSync(path.resolve(process.cwd(), file.from))).toBe(true);
  }
  const text = files.map((f) => ("text" in f ? f.text : "")).join("\n");
  expect(text).not.toMatch(/clientSecret|test_credentials|reviewer_instructions|\.app\.json/);
  expect(Object.keys(json("mcp.json").mcpServers)).toHaveLength(1);
});

test("each skill has the frontmatter ChatGPT reads to pick it", () => {
  const skills = files.filter((f) => f.path.startsWith("skills/"));
  expect(skills.length).toBeGreaterThan(10);
  for (const skill of skills) {
    if (!("text" in skill)) throw new Error(skill.path);
    const name = skill.path.split("/")[1];
    expect(skill.text.startsWith(`---\nname: ${name}\ndescription: "`)).toBe(true);
    const description = JSON.parse(skill.text.split("\n")[2].slice("description: ".length));
    expect(description.length).toBeGreaterThan(40);
    expect(skill.text.split("---\n")[2].trim().length).toBeGreaterThan(100);
  }
});
