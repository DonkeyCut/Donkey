import { describe, expect, test } from "bun:test";
import { AI_TOOLS, areaTools, CORE_TOOLS, REQUEST_TOOLS_DEF, TOOL_AREA_NAMES } from "./catalog";
import { declaresTool, declareTurn, dropTurn, takeWidened, turnTools, widenTurn } from "./turnCatalog";

const names = (key: string) => turnTools(key).map((t) => t.name);

describe("turnCatalog", () => {
  test("an unrouted turn lists the whole catalog", () => {
    declareTurn("unrouted", undefined, "live");
    expect(names("unrouted")).toEqual(AI_TOOLS.map((t) => t.name));
    expect(turnTools(null)).toBe(AI_TOOLS);
    dropTurn("unrouted");
  });

  test("a routed turn lists the core, its areas and the escape hatch", () => {
    declareTurn("routed", { intent: "simple", areas: ["timeline"], gate: true }, "live");
    const listed = new Set(names("routed"));
    for (const t of [...CORE_TOOLS, ...areaTools(["timeline"])]) expect(listed.has(t.name)).toBe(true);
    expect(listed.has(REQUEST_TOOLS_DEF.name)).toBe(true);
    expect(listed.has(areaTools(["color"])[0].name)).toBe(false);
    expect(declaresTool("routed", areaTools(["color"])[0].name)).toBe(false);
    dropTurn("routed");
  });

  test("a turn routed to every area lists the whole catalog with no escape hatch", () => {
    declareTurn("every", { intent: "complex", areas: [...TOOL_AREA_NAMES], gate: true }, "live");
    expect(names("every")).toEqual(AI_TOOLS.map((t) => t.name));
    dropTurn("every");
  });

  test("a chat turn keeps only the skill readers", () => {
    declareTurn("chat", { intent: "chat", areas: [...TOOL_AREA_NAMES], gate: true }, "live");
    expect(names("chat").sort()).toEqual(["list_skills", "read_skill"]);
    expect(declaresTool("chat", "set_project_name")).toBe(false);
    dropTurn("chat");
  });

  test("request_tools widens the listing, live for Claude", () => {
    declareTurn("widen-live", { intent: "simple", areas: ["timeline"], gate: true }, "live");
    const colorTool = areaTools(["color"])[0].name;
    const result = widenTurn("widen-live", ["color", "timeline", "nonsense"]);
    expect(result.added).toEqual(["color"]);
    expect(result.tools).toContain(colorTool);
    expect(result.note).toBe("Available from your next step.");
    expect(declaresTool("widen-live", colorTool)).toBe(true);
    expect(takeWidened("widen-live")).toBe(false);
    dropTurn("widen-live");
  });

  test("a Codex turn resumes once per widening to list the new tools", () => {
    declareTurn("widen-run", { intent: "simple", areas: ["timeline"], gate: true }, "next-run");
    expect(takeWidened("widen-run")).toBe(false);
    expect(widenTurn("widen-run", ["color"]).note).toContain("next run");
    expect(takeWidened("widen-run")).toBe(true);
    expect(takeWidened("widen-run")).toBe(false);
    expect(widenTurn("widen-run", ["color"]).added).toEqual([]);
    expect(takeWidened("widen-run")).toBe(false);
    dropTurn("widen-run");
  });
});
