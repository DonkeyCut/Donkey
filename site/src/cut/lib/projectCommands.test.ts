import { expect, spyOn, test } from "bun:test";
import { runProjectCommand } from "./aiTools";
import { browserBackend } from "./backend/browser";
import { projectOperation } from "./projectOperation";
import { noteProjectRevision } from "./projectRevision";
import { useEditor } from "./store";

test("a headless project command edits the document without an inference request", async () => {
  const before = useEditor.getState();
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Unexpected network request"); });
  try {
    useEditor.setState({ projectId: "project-command-edit", loaded: true, background: "#000000" });
    noteProjectRevision("project-command-edit", "1");
    const operation = projectOperation("project-command-edit", browserBackend);
    const result = await runProjectCommand(operation, "set_background", { color: "#123456" });
    expect(result).toEqual({ background: "#123456" });
    expect(useEditor.getState().background).toBe("#123456");
    expect(fetcher).not.toHaveBeenCalled();
    noteProjectRevision("project-command-edit", "2");
    await expect(runProjectCommand(operation, "set_background", { color: "#ffffff" })).rejects.toThrow("changed since");
    expect(useEditor.getState().background).toBe("#123456");
  } finally {
    fetcher.mockRestore();
    useEditor.setState(before, true);
  }
});
