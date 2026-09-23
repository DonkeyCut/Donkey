// A batch of typed editor commands, run by the editor inside the ChatGPT
// card on the document the user is looking at.
import { adoptImportedFiles } from "./media";

export interface CommandCall {
  name: string;
  input: Record<string, unknown>;
}

export interface CommandJobSpec {
  commands: CommandCall[];
  /** A read: the document is inspected, never saved. */
  readOnly?: boolean;
  /** The undo history's name for this batch. */
  label?: string;
}

export interface CommandOutcome {
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
}

/** What a commands job records in CutRenderJob.result. */
export interface CommandJobResult {
  results: CommandOutcome[];
  /** The document changed and was saved. */
  changed: boolean;
  /** The project version after the save, when one happened. */
  docVersion: string | null;
}

/** Register files an import landed in the project's media as assets. An
 * internal command: the import job downloads, the batch that follows adopts,
 * so the adoption happens in the open editor. */
export const ADOPT_COMMAND = "adopt_imported_files";

export interface AdoptedAsset {
  assetId: string;
  name: string;
  kind: string;
  duration: number;
  fileName: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
}

/** The undo history's name for a batch: its label, or the commands that ran. */
export function batchLabel(spec: Pick<CommandJobSpec, "label">, results: CommandOutcome[]): string {
  return spec.label?.trim() || results.filter((r) => r.ok).map((r) => r.name).join(", ") || "Edit";
}

/** Contact sheets, captured frames and listened audio ride in the result as
 * data URLs. The result is one POST to the hosted API, whose request body
 * caps at 4.5 MB, so past this much the later ones are dropped and say so. */
const MAX_MEDIA_BYTES = 3.5 * 1024 * 1024;

/** Keep the batch's inline media (frames, sheets, listened audio) inside one
 * result budget. */
export function boundMedia(results: CommandOutcome[]): void {
  let budget = MAX_MEDIA_BYTES;
  const take = (url: unknown): unknown => {
    if (typeof url !== "string" || !url.startsWith("data:")) return url;
    if (url.length <= budget) {
      budget -= url.length;
      return url;
    }
    return "[dropped: the batch's inline media exceeds the result budget — ask for this in its own call]";
  };
  for (const r of results) {
    const out = r.output as { image?: unknown; images?: unknown[]; audio?: unknown } | null;
    if (!out || typeof out !== "object") continue;
    if ("image" in out) out.image = take(out.image);
    if (Array.isArray(out.images)) out.images = out.images.map(take);
    if ("audio" in out) out.audio = take(out.audio);
  }
}

async function adoptFiles(projectId: string, input: Record<string, unknown>): Promise<{ assets: AdoptedAsset[] }> {
  const files = Array.isArray(input.files) ? (input.files as { fileName?: unknown; title?: unknown }[]) : [];
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : null;
  const landed = files
    .filter((f): f is { fileName: string; title?: unknown } => typeof f?.fileName === "string" && f.fileName.length > 0)
    .map((f) => ({ fileName: f.fileName, title: typeof f.title === "string" && f.title ? f.title : f.fileName }));
  // The name the user gave applies when it can only mean one file.
  if (name && landed.length === 1) landed[0].title = name;
  const { assets } = await adoptImportedFiles(projectId, { files: landed });
  return {
    assets: assets.map((a) => ({
      assetId: a.id, name: a.name, kind: a.type, duration: Math.round(a.duration * 100) / 100,
      fileName: a.fileName, sizeBytes: a.sizeBytes, width: a.width, height: a.height,
    })),
  };
}

/** Run the commands in order through `exec`. The batch stops at the first
 * failure: later commands assumed this one landed, and the caller sees
 * exactly how far it got. */
export async function runCommandBatch(
  projectId: string,
  commands: CommandCall[],
  exec: (name: string, input: Record<string, unknown>) => Promise<unknown>,
  opts: { isCanceled?: () => boolean; onProgress?: (fraction: number) => void } = {}
): Promise<CommandOutcome[]> {
  const results: CommandOutcome[] = [];
  for (const [i, call] of commands.entries()) {
    if (opts.isCanceled?.()) throw new Error("Canceled.");
    opts.onProgress?.(i / commands.length);
    const input = call.input ?? {};
    try {
      const output = call.name === ADOPT_COMMAND ? await adoptFiles(projectId, input) : await exec(call.name, input);
      results.push({ name: call.name, ok: true, output: output ?? null });
    } catch (err) {
      results.push({ name: call.name, ok: false, error: err instanceof Error ? err.message : String(err) });
      break;
    }
  }
  boundMedia(results);
  opts.onProgress?.(1);
  return results;
}
