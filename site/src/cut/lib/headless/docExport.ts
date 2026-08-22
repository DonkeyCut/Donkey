import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildExportPayload,
  EXPORT_PRESETS,
  originalSettings,
  presetSettings,
  type ExportDoc,
  type ExportSettings,
} from "../exportClient";
import { useEditor } from "../store";
import { bindHeadlessSession, type HeadlessSession } from "./bind";
import { openCloudProject } from "./docSession";

// A whole-timeline export built where the tab used to be. A client that can
// render the cut itself sends the finished spec up; a client that cannot —
// the phone — asks for the project by id, and this builds the same spec from
// the stored document: open the doc into the editor store, run the export
// payload builder the dialog runs, and drop the overlay pictures straight
// into the render's own tmp dir.

/** The sizes a doc-built export offers, named as the export dialog names
 * them. `original` is derived from the footage on the timeline; the rest are
 * the fixed presets flipped to the project's ratio. */
export const DOC_EXPORT_PRESETS = ["original", ...EXPORT_PRESETS.map((p) => p.id)] as const;

export type DocExportPreset = (typeof DOC_EXPORT_PRESETS)[number];

export function isDocExportPreset(value: unknown): value is DocExportPreset {
  return typeof value === "string" && (DOC_EXPORT_PRESETS as readonly string[]).includes(value);
}

/** The editor store's current contents as the builder's neutral document. */
function docFromStore(): ExportDoc {
  const s = useEditor.getState();
  return {
    aspect: s.aspect,
    assets: s.assets,
    clips: s.clips,
    audioClips: s.audioClips,
    overlays: s.overlays,
    subtitles: s.subtitles,
    fadeIn: s.fadeIn,
    fadeOut: s.fadeOut,
    background: s.background,
  };
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
  tmpDir: string
): Promise<object> {
  bindHeadlessSession(session);
  await openCloudProject(session, projectId);
  const doc = docFromStore();
  const payload = await buildExportPayload(projectId, doc, settingsFor(preset, doc), "export");
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
