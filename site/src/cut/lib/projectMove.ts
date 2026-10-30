// Moving the open project to another residency: the top bar's Move to Cloud
// and the storage wall's move to this computer. The copy lands first, which is
// what makes deleting the original safe.
import { backendFor, type Residency } from "./residency";
import { clearProjectThreads } from "./chatThreads";
import { dropLocalProjectCopy } from "./mediaSync";
import { copyProjectAcross } from "./projectCopy";
import { useEditor } from "./store";

// How long the move waits for a pending autosave, so the copy reads the
// current cut: this many checks, this far apart.
const SAVE_CHECKS = 40;
const SAVE_CHECK_MS = 250;

/** Copies the open project to `to` and drops the original; returns the
 * copy's id. */
export async function moveOpenProject(
  from: Residency,
  to: Residency,
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  const projectId = useEditor.getState().projectId;
  if (!projectId) {
    throw new Error("No project is open.");
  }
  for (let i = 0; i < SAVE_CHECKS && useEditor.getState().saveState !== "saved"; i++) {
    await new Promise((r) => setTimeout(r, SAVE_CHECK_MS));
  }

  const newId = await copyProjectAcross(backendFor(from), backendFor(to), projectId, { onProgress });
  await backendFor(from)
    .fetch(`/api/cut/projects/${projectId}`, { method: "DELETE" })
    .catch(() => {});

  // The chat history moved with the project; the old project's copy goes
  // with the project itself, as does a cloud project's browser-store copy
  // (an import the cloud refused waits there, and the copy took it along).
  clearProjectThreads(projectId);
  if (from === "cloud") {
    await dropLocalProjectCopy(projectId).catch(() => {});
  }
  return newId;
}
