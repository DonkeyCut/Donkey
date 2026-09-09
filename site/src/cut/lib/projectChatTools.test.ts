import { expect, test } from "bun:test";
import { useEditor } from "./store";
import { withChatProject } from "./projectChatTools";

test("a suspended tool waits for its own project and cannot edit the replacement", async () => {
  useEditor.setState({ projectId: "replacement", loaded: true, projectName: "Unchanged" });
  let ran = false;
  const tool = withChatProject("original", async () => {
    ran = true;
    useEditor.getState().setProjectName("Original edited");
  });
  await Promise.resolve();
  expect(ran).toBe(false);
  expect(useEditor.getState().projectName).toBe("Unchanged");
  useEditor.setState({ projectId: "original", loaded: true });
  await tool;
  expect(useEditor.getState().projectName).toBe("Original edited");
});

test("Stop cancels a tool waiting for a project to reopen", async () => {
  useEditor.setState({ projectId: "replacement", loaded: true });
  const abort = new AbortController();
  let ran = false;
  const tool = withChatProject("original", async () => { ran = true; }, abort.signal);
  abort.abort();
  const result = await tool.catch((error: unknown) => error);
  expect(result instanceof DOMException && result.name === "AbortError").toBe(true);
  expect(ran).toBe(false);
});
