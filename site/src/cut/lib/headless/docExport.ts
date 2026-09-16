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

/** The sizes a doc-built export offers, named as the export dialog names
 * them. `original` is derived from the footage on the timeline; the rest are
 * the fixed presets flipped to the project's ratio. */
export const DOC_EXPORT_PRESETS = ["original", ...EXPORT_PRESETS.map((p) => p.id)] as const;

export type DocExportPreset = (typeof DOC_EXPORT_PRESETS)[number];

export function isDocExportPreset(value: unknown): value is DocExportPreset {
  return typeof value === "string" && (DOC_EXPORT_PRESETS as readonly string[]).includes(value);
}

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
