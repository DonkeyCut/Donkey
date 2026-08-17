import { runAiTool, UI_TOOLS } from "../../lib/aiTools";
import { serializeDoc, useEditor } from "../../lib/store";
import type { MediaAsset, ProjectDoc } from "../../lib/types";
import { readProject, writeProject } from "../projects";

// The engine's own tool executor, for a chat whose editor tab is gone: the
// project doc hydrates into the same store the page uses, tools run against
// it, and every mutation lands back on disk. A turn survives its tab.
//
// Scope: doc edits. Tools that need the page (preview reads, media decodes)
// or the page's hosted sign-in (generation, library sync) answer with a
// typed refusal so the model reports honestly and moves on.

/** Tools that decode or rasterize media. The engine runs on Bun with the
 * bundled tools and no canvas, decoders or Web Audio, so these answer with a
 * typed refusal here; the cloud runner installs those primitives and runs the
 * same tools for real. */
const PAGE_MEDIA_TOOLS: ReadonlySet<string> = new Set([
  "watch_video",
  "listen_audio",
  "detect_silence",
  "refine_speech_cuts",
  "freeze_frame",
  "capture_frame",
  "create_sticker",
  "subtitles_generate",
  "captions_generate",
  "subtitles_from_visuals",
  "stock_add",
]);

const PAGE_SESSION_TOOLS: ReadonlySet<string> = new Set([
  "generate_image",
  "generate_video",
  "generate_character_video",
  "generate_scene",
  "approve_scene",
  "cancel_scene",
  "regenerate_shot",
  "recut_scene",
  "restyle_scene",
  "generate_music",
  "voiceover_generate",
  "read_subtitles_aloud",
  "subtitles_translate_track",
  "wait_for_renders",
  "library_list",
  "library_add",
  "library_organize",
  "template_add",
  "file_asset",
  "import_url",
]);

interface OpenDoc {
  projectId: string;
  stored: ProjectDoc;
}

let open: OpenDoc | null = null;

async function ensureOpen(projectId: string): Promise<OpenDoc | null> {
  // Read the doc on every call: the page saves through writeProject between
  // turns, and flushing a store hydrated from an older read would revert
  // those edits. The store is reused only while the disk copy still matches
  // the one it was hydrated from.
  const stored = await readProject(projectId);
  if (!stored) return null;
  const s = useEditor.getState();
  if (
    open?.projectId === projectId &&
    s.projectId === projectId &&
    s.loaded &&
    stored.updatedAt === open.stored.updatedAt
  ) {
    return open;
  }
  const assets: MediaAsset[] = (stored.assets ?? []).map((a) => ({
    ...a,
    url: `/api/cut/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(a.fileName)}`,
  }));
  await useEditor.getState().openProjectDoc(projectId, stored, assets);
  open = { projectId, stored };
  return open;
}

async function flush(doc: OpenDoc): Promise<void> {
  const merged = { ...doc.stored, ...serializeDoc(useEditor.getState()) } as ProjectDoc;
  await writeProject(doc.projectId, merged);
  doc.stored = merged;
}

/** Run one tool call against the engine-held store for `projectId`,
 * persisting the doc after it. The bridge calls this when no editor tab is
 * attached to the chat session. */
export async function callHeadlessTool(
  projectId: string,
  toolName: string,
  input: unknown
): Promise<{ output?: unknown; errorText?: string }> {
  if (UI_TOOLS.has(toolName))
    return {
      output: {
        noEditor: true,
        note: "No editor page is attached to this session, so this tool had no effect. The project itself is unchanged — keep working from the editor state.",
      },
    };
  if (PAGE_MEDIA_TOOLS.has(toolName))
    return {
      errorText:
        "This tool reads media through the editor page and is unavailable while no tab is attached. Work from the editor state instead.",
    };
  if (PAGE_SESSION_TOOLS.has(toolName))
    return {
      errorText:
        "This tool runs with the editor page's hosted sign-in and is unavailable while no tab is attached. Finish the edit from the project state; the user can run it from the editor.",
    };
  const doc = await ensureOpen(projectId);
  if (!doc) return { errorText: "Project not found on this Mac." };
  try {
    const output = await runAiTool(toolName, (input ?? {}) as Record<string, unknown>);
    await flush(doc);
    return { output: output ?? null };
  } catch (err) {
    return { errorText: err instanceof Error ? err.message : String(err) };
  }
}
