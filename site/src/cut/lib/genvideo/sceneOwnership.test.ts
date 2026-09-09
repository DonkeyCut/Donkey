import { afterEach, expect, test } from "bun:test";
import { cloudBackend, knownDocVersion } from "../backend/cloud";
import { registerEditorSave } from "../editorWork";
import { noteProjectRevision } from "../projectRevision";
import { useEditor } from "../store";
import type { VideoOrchestrator } from "./orchestrator";
import type { VideoProject } from "./types";
import { ownScene } from "./sceneOwnership";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function scene(id: string, run: (project: VideoProject) => void) {
  const project = { id, phase: "brief", updatedAt: 1 } as VideoProject;
  const mockScene = {
    project, isAborted: false,
    abort: () => { mockScene.isAborted = true; },
    run: async () => { run(mockScene.project); return mockScene.project; },
  };
  return mockScene as unknown as VideoOrchestrator;
}

test("scene ownership cannot advance the save base of a stale editor", async () => {
  const id = "stale-scene-editor";
  let version = "1";
  let writes = 0;
  let ran = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/scene-lease")) return Response.json({ acquired: true });
    if (init?.method === "PUT") writes++;
    return Response.json({ name: "Another tab's title" }, { headers: { "x-cut-doc-version": version } });
  }) as typeof fetch;
  await cloudBackend.fetch(`/api/cut/projects/${id}`);
  noteProjectRevision(id, "1");
  useEditor.setState({ projectId: id, loaded: true, projectName: "Old title", saveState: "saved" });
  version = "2";
  const result = await ownScene(id, scene("new-scene", () => { ran = true; }), true).run().catch((error: unknown) => error);
  expect(result instanceof Error && result.message.includes("changed in another tab")).toBe(true);
  expect(knownDocVersion(id)).toBe("1");
  expect(writes).toBe(0);
  expect(ran).toBe(false);
});

test("a new scene drains the cancellation save before checking the persisted plan", async () => {
  const id = "cancel-then-start";
  let persisted: VideoProject | undefined = { id: "cancelled", phase: "storyboard" } as VideoProject;
  let ran = false;
  useEditor.setState({ projectId: id, loaded: true, genvideo: undefined, saveState: "dirty" });
  noteProjectRevision(id, "1");
  const unregister = registerEditorSave(id, async () => {
    persisted = useEditor.getState().genvideo;
    useEditor.getState().setSaveState("saved");
  });
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/scene-lease")) return Response.json({ acquired: true });
    return Response.json({ genvideo: persisted }, { headers: { "x-cut-doc-version": "1" } });
  }) as typeof fetch;
  try {
    await ownScene(id, scene("next-scene", (project) => {
      ran = true;
      useEditor.getState().setGenvideo(project);
    }), true).run();
    expect(ran).toBe(true);
    expect(persisted?.id).toBe("next-scene");
  } finally { unregister(); }
});
