import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildExportPayload,
  EXPORT_PRESETS,
  originalSettings,
  matchSourceSettings,
  presetSettings,
  previewSettings,
  type ExportSettings,
} from "../exportClient";
import { renderDoc, type ExportDoc } from "@/cut/lib/renderSnapshot";
import { useEditor } from "../store";
import { sourceExportProfile } from "@/cut/lib/exportRender";
import { bindHeadlessSession, type HeadlessSession } from "./bind";
import { openCloudSnapshot, type CloudDocSnapshot } from "./docSession";
import { loudnessSettings } from "../loudnessSettings";

// Queued document exports hydrate their captured revision in an isolated
// worker, prepare the same payload as the editor, and stage its overlay
// pictures in the render's own scratch directory.

export { DOC_EXPORT_PRESETS, isDocExportPreset, type DocExportAudio, type DocExportPreset } from "../exportPresets";
import type { DocExportAudio, DocExportPreset } from "../exportPresets";

async function settingsFor(preset: DocExportPreset, doc: ExportDoc): Promise<ExportSettings> {
  const fixed = EXPORT_PRESETS.find((p) => p.id === preset);
  if (fixed) return presetSettings(fixed, doc.aspect);
  const source = await sourceExportProfile(doc, (asset) => asset.url);
  return matchSourceSettings(originalSettings(doc.aspect, doc.clips, doc.assets, doc),
    { ...source, ...(doc.audioClips.length > 0 ? { audioBitrate: undefined, audioSampleRate: undefined, audioChannels: undefined } : {}) });
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
  target: "export" | "preview" = "export",
  audio: DocExportAudio = {}
): Promise<object> {
  bindHeadlessSession(session);
  await openCloudSnapshot(session, projectId, snapshot);
  const doc = renderDoc(useEditor.getState());
  const settings: ExportSettings =
    target === "preview"
      ? previewSettings(doc.aspect)
      : {
          ...(await settingsFor(preset, doc)),
          ...loudnessSettings(audio.loudness),
          ...(audio.stems ? { stems: true } : {}),
        };
  const payload = await buildExportPayload(projectId, doc, settings, target);
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
