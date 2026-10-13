import { beforeEach, expect, test } from "bun:test";
import { buildAiContext } from "./aiContext";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { SIDE_PANEL_TOOLS } from "../components/SidePanel.tools";

/** The project's own notes — the Details tab's date, links and text — are
 * where a cut keeps its source. The chat had no way to write them, so a
 * template's original link went into the account's Notes instead, where
 * nobody opening the project would see it. */

beforeEach(() => useEditor.setState({ notes: { text: "", publishedAt: "", links: [] } }));

test("set_project_notes adds a link without dropping the ones already there", async () => {
  useEditor.getState().setNotes({ links: ["https://a.test/1"] });
  const out = (await runAiTool("set_project_notes", { add_links: ["https://www.instagram.com/reel/X/", "https://a.test/1"] })) as {
    links: string[];
  };
  expect(out.links).toEqual(["https://a.test/1", "https://www.instagram.com/reel/X/"]);
  expect(useEditor.getState().notes.links).toEqual(out.links);
});

test("text, date and a whole link list can be set; a bad date is refused", async () => {
  await runAiTool("set_project_notes", { text: "Replica of a recap reel", published_at: "2026-10-13", links: ["https://b.test"] });
  expect(useEditor.getState().notes).toEqual({ text: "Replica of a recap reel", publishedAt: "2026-10-13", links: ["https://b.test"] });
  await expect(runAiTool("set_project_notes", { published_at: "13/10/2026" })).rejects.toThrow();
  await expect(runAiTool("set_project_notes", {})).rejects.toThrow();
});

test("the chat sees the notes and the tool", () => {
  useEditor.getState().setNotes({ links: ["https://c.test"] });
  expect(JSON.stringify(buildAiContext())).toContain("https://c.test");
  expect(SIDE_PANEL_TOOLS.some((t) => t.name === "set_project_notes")).toBe(true);
});
