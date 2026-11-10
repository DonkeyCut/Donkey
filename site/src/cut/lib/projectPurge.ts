// What the page holds for a project, let go once the project is deleted.
import { clearProjectThreads } from "./chatThreads";
import { dropCachedDoc } from "./docCache";
import { useGenerate } from "./generate";
import { useGenScene } from "./genScene";
import { dropLocalProjectCopy } from "./mediaSync";
import type { Residency } from "./residency";

/** Stop the project's renders, so none lands back after the delete, and drop
 * its conversations, cached document and local media copy. */
export function forgetProject(id: string, residency: Residency) {
  useGenScene.getState().killProject(id);
  useGenerate.getState().cancelForOwner({ projectId: id });
  clearProjectThreads(id);
  dropCachedDoc(id, residency);
  if (residency === "cloud") {
    void dropLocalProjectCopy(id);
  }
}
