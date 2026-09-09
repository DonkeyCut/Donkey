import { flushEditorSave } from "../editorWork";
import { chatRuntime } from "../chatRuntime";
import { projectBackend } from "../residency";
import { useEditor } from "../store";
import { projectRevision } from "../projectRevision";
import type { ProjectDoc } from "../types";
import { docWriterIdle } from "./docWriter";
import { VideoOrchestrator } from "./orchestrator";
import { SceneOwnedElsewhere, withSceneLease } from "./sceneLease";
export { SceneOwnedElsewhere } from "./sceneLease";

/** Every entry into a scene takes the project's lease, including reload recovery. */
export function ownScene(projectId: string, scene: VideoOrchestrator, fresh = false) {
  let busy = false;
  const run = async (work: () => ReturnType<VideoOrchestrator["run"]>) => {
    if (busy) throw new SceneOwnedElsewhere();
    busy = true;
    try {
      const backend = await projectBackend(projectId);
      const owner = crypto.randomUUID();
      const route = `/api/cut/projects/${encodeURIComponent(projectId)}/scene-lease`;
      let leaseMs = chatRuntime().sceneLeaseMs;
      const lease = async (release = false) => {
        const res = await backend.fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ owner, release, leaseMs: chatRuntime().sceneLeaseMs }) });
        if (!res.ok) throw new Error("Could not reserve the video run.");
        const result = await res.json() as { acquired: boolean; leaseMs?: number };
        if (result.leaseMs) leaseMs = result.leaseMs;
        return result.acquired;
      };
      const execute = async () => {
        await flushEditorSave(projectId);
        await docWriterIdle(projectId);
        const res = await backend.fetch(`/api/cut/projects/${encodeURIComponent(projectId)}`, { observe: true });
        if (!res.ok) throw new Error("Could not read the video run.");
        const doc = await res.json() as ProjectDoc;
        const current = useEditor.getState();
        const revision = res.headers.get("x-cut-doc-version");
        if (backend.kind === "cloud" && current.projectId === projectId && current.loaded &&
            revision && projectRevision(projectId) !== revision)
          throw new Error("The project changed in another tab. Reload it before continuing the video run.");
        if (!fresh && doc.genvideo?.id !== scene.project.id) {
          scene.abort();
          return scene.project;
        }
        if (fresh && doc.genvideo && doc.genvideo.phase !== "done" && doc.genvideo.phase !== "failed")
          throw new SceneOwnedElsewhere();
        if (doc.genvideo?.id === scene.project.id && doc.genvideo.updatedAt > scene.project.updatedAt)
          scene.project = structuredClone(doc.genvideo);
        if (scene.isAborted) return scene.project;
        const result = await work();
        fresh = false;
        if (scene.isAborted) return result;
        await flushEditorSave(projectId);
        await docWriterIdle(projectId);
        return result;
      };
      if (backend.kind === "browser") {
        if (typeof navigator === "undefined" || !navigator.locks) throw new Error("This browser cannot coordinate background video runs.");
        return await navigator.locks.request(`cut-scene:${projectId}`, { ifAvailable: true }, async (lock) => {
          if (!lock) throw new SceneOwnedElsewhere();
          return execute();
        });
      }
      return await withSceneLease(lease, execute, () => scene.abort(), () => leaseMs / 3);
    } finally { busy = false; }
  };
  return {
    get project() { return scene.project; },
    get isAborted() { return scene.isAborted; },
    get working() { return busy; },
    abort: () => scene.abort(),
    shotIdByNumber: (n: number) => scene.shotIdByNumber(n),
    run: () => run(() => scene.run()),
    approveBreakdown: () => run(() => scene.approveBreakdown()),
    retryFailed: () => run(() => scene.retryFailed()),
    regenerateShots: (ids: string[]) => run(() => scene.regenerateShots(ids)),
    applyShotNote: (id: string, note: string) => run(() => scene.applyShotNote(id, note)),
    reviseStoryboardFrame: (id: string, note?: string) => run(() => scene.reviseStoryboardFrame(id, note)),
    recutShots: (ids: string[], instruction: string) => run(() => scene.recutShots(ids, instruction)),
    changeStyle: (style: string) => run(() => scene.changeStyle(style)),
  };
}
