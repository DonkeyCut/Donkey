import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExport, type ExportSpec, type RenderHandle } from "../server/exportPipeline";
import { storeCardArtifacts } from "./cardJob";
import { prisma, registerObject, type ClaimedJob } from "./db";
import { downloadToFile, exportKey, mediaKey, previewKey, uploadFile } from "./r2";

/** The stored spec of an export/preview CutRenderJob: the engine export spec
 * plus the R2 keys of the browser-rendered overlay PNGs (title/caption stills
 * and sub_blank.png). The queueing route (cloud/jobs.ts) stores exactly this
 * and puts the already-deduped export name on the row's outName column. */
interface ExportJobSpec {
  spec: ExportSpec;
  overlays?: { name: string; key: string }[];
}

/** The job's overlay-PNG R2 keys, restricted to the job owner's own overlay
 * namespace — the queueing route already rejects foreign keys, and this keeps
 * the worker safe against rows written any other way. */
export function overlayKeysOf(job: ClaimedJob): string[] {
  const overlays = (job.spec as ExportJobSpec | null)?.overlays ?? [];
  const prefix = `cut/${job.userId}/overlays/`;
  return overlays
    .map((o) => o?.key)
    .filter((k): k is string => typeof k === "string" && k.startsWith(prefix));
}

/**
 * Run one export, preview, or card job: stage a project-shaped work dir
 * (media/ + overlay PNGs in the pipeline tmp dir), render through the engine's
 * shared pipeline, and land the result back in R2 — the mp4 for an export or
 * hover proxy, the derived still and animation for a card. Returns what the
 * job row records.
 */
export async function runExportJob(
  job: ClaimedJob,
  handle: RenderHandle
): Promise<{ outputKey: string; outName: string }> {
  const body = job.spec as ExportJobSpec;
  const spec = body.spec;
  if (!spec || !Array.isArray(spec.clips)) throw new Error("Malformed export spec.");
  const projectId = job.projectId ?? spec.projectId;
  if (!projectId) throw new Error("Export job has no project.");
  const mode: "export" | "preview" | "card" =
    job.kind === "preview" || spec.target === "preview"
      ? "preview"
      : job.kind === "card" || spec.target === "card"
        ? "card"
        : "export";
  const preview = mode === "preview";

  const work = await mkdtemp(path.join(os.tmpdir(), "cut-worker-"));
  try {
    // The pipeline reads overlay/caption PNGs from handle.tmpDir by base name
    // and writes its encode intermediate there too — mirror the engine's
    // uploaded-PNG staging.
    handle.tmpDir = path.join(work, "overlays");
    const mediaDir = path.join(work, "media");
    await Promise.all([mkdir(handle.tmpDir, { recursive: true }), mkdir(mediaDir, { recursive: true })]);

    const mediaFiles = new Set<string>();
    for (const c of spec.clips) if (c.file) mediaFiles.add(c.file);
    for (const o of spec.overlayVideos ?? []) if (o.file) mediaFiles.add(o.file);
    for (const a of spec.audio ?? []) if (a.file) mediaFiles.add(a.file);
    const overlayPrefix = `cut/${job.userId}/overlays/`;
    for (const o of body.overlays ?? []) {
      if (!o.key.startsWith(overlayPrefix)) throw new Error("Invalid overlay key.");
    }
    await Promise.all([
      ...[...mediaFiles].map((f) =>
        downloadToFile(mediaKey(job.userId, projectId, f), path.join(mediaDir, path.basename(f)))
      ),
      ...(body.overlays ?? []).map((o) =>
        downloadToFile(o.key, path.join(handle.tmpDir, path.basename(o.name)))
      ),
    ]);

    const outName = mode === "export" ? job.outName?.trim() || "export.mp4" : `${mode}.mp4`;
    handle.outPath = path.join(work, "out", outName);
    await mkdir(path.dirname(handle.outPath), { recursive: true });

    await runExport(handle, spec, (file) => path.join(mediaDir, path.basename(file)));

    // A card's rendered clip is scratch: only the still and the animation it
    // derives are stored, so the mp4 never reaches R2.
    if (mode === "card") return storeCardArtifacts(job, handle, projectId);

    // The project may have been deleted (its jobs canceled) between the
    // watcher's last tick and now; registering the output then would charge
    // storage nothing can ever free.
    const live = await prisma.cutRenderJob.findUnique({
      where: { id: job.id },
      select: { state: true },
    });
    if (live?.state !== "running") throw new Error("Canceled.");

    const key = preview
      ? previewKey(job.userId, projectId)
      : exportKey(job.userId, projectId, outName);
    const bytes = await uploadFile(key, handle.outPath, "video/mp4");
    await registerObject({
      userId: job.userId,
      projectId,
      r2Key: key,
      fileName: outName,
      mime: "video/mp4",
      bytes,
      kind: preview ? "preview" : "export",
    });
    if (preview) {
      // Best-effort: a project deleted mid-render just drops its proxy.
      await prisma.cutProject
        .update({ where: { id: projectId }, data: { previewKey: key } })
        .catch(() => {});
    }
    return { outputKey: key, outName };
  } finally {
    void rm(work, { recursive: true, force: true });
  }
}
