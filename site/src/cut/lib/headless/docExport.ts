import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildExportPayload,
  EXPORT_PRESETS,
  originalSettings,
  presetSettings,
  previewSettings,
  type ExportSettings,
} from "../exportClient";
import { renderDoc, type ExportDoc } from "@/cut/lib/renderSnapshot";
import { useEditor } from "../store";
import { bindHeadlessSession, type HeadlessSession } from "./bind";
import { openCloudSnapshot, type CloudDocSnapshot } from "./docSession";

// Queued document exports hydrate their captured revision in an isolated
// worker, prepare the same payload as the editor, and stage its overlay
// pictures in the render's own scratch directory.

export { DOC_EXPORT_PRESETS, isDocExportPreset, type DocExportPreset } from "../exportPresets";
import type { DocExportPreset } from "../exportPresets";

function settingsFor(preset: DocExportPreset, doc: ExportDoc): ExportSettings {
  const fixed = EXPORT_PRESETS.find((p) => p.id === preset);
  return fixed
    ? presetSettings(fixed, doc.aspect)
    : originalSettings(doc.aspect, doc.clips, doc.assets);
}

/**
 * Build the render spec for a cloud project's whole timeline and stage its
 * overlay pictures in `tmpDir` — the directory the pipeline reads stills from
 * by base name.
 */
export async function buildDocExportSpec(
  session: HeadlessSession,
  projectId: string,
  preset: DocExportPreset,
  tmpDir: string,
  snapshot: CloudDocSnapshot,
  target: "export" | "preview" = "export"
): Promise<object> {
  bindHeadlessSession(session);
  await openCloudSnapshot(session, projectId, snapshot);
  const doc = renderDoc(useEditor.getState());
  const payload = await buildExportPayload(projectId, doc, target === "preview" ? previewSettings(doc.aspect) : settingsFor(preset, doc), target);
  await Promise.all(
    payload.pngs.map(async (p) =>
      writeFile(
        path.join(tmpDir, path.basename(p.name)),
        Buffer.from(await p.blob.arrayBuffer())
      )
    )
  );
  return payload.spec;
}
