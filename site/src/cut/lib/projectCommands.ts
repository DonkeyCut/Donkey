import type { ProjectOperation } from "@/cut/lib/projectOperation";

export const UI_TOOLS: ReadonlySet<string> = new Set([
  "set_side_panel", "set_view", "open_export", "set_playing",
]);

export function assertProjectCommand(operation: ProjectOperation, activeProjectId: string | null, name: string, activeVersion?: string | null): void {
  if (operation.residency === "shared") throw new Error("A shared project is read-only.");
  if (operation.projectId !== activeProjectId) throw new Error("The command's project is no longer open.");
  if (operation.version !== null && activeVersion != null && operation.version !== activeVersion)
    throw new Error("The project changed since this command was prepared.");
  if (UI_TOOLS.has(name)) throw new Error("This command requires an editor interface.");
}
