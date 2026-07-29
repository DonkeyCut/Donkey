// The share-playback job: render the cut, then package it as an HLS ladder in
// R2 so a shared project streams instead of downloading.
//
// It renders its own master rather than reusing an export. An export is
// whatever settings the user picked and may not exist at all; the ladder has to
// track the CURRENT doc, since that is what the share serves.
//
// The ladder publishes in two passes. The low rungs go up first and the master
// is written the moment they land, so a share becomes watchable in a fraction
// of the total encode; the high rungs follow and the master is rewritten to
// include them. Without that split a 4K cut would be unwatchable until the
// slowest rung finished.
import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  FIRST_PASS_RUNGS,
  encodeRungs,
  listFiles,
  planLadder,
  probeSource,
  writeMaster,
  type Variant,
} from "../server/hlsLadder";
import type { RenderHandle } from "../server/exportPipeline";
import { runExport } from "../server/exportPipeline";
import { beginLadder, publishLadder } from "../server/cloud/ladderStore";
import { inWorkDir, stageJobMedia, type ExportJobSpec } from "./exportJob";
import { prisma, type ClaimedJob } from "./db";
import { hlsPrefix, uploadTree } from "./r2";

/** Progress split between rendering the master and packaging the ladder. The
 * ladder is the longer half on a large frame — it encodes the whole cut once
 * per rung — so the render is not allowed to look like most of the job. */
const RENDER_SHARE = 0.35;

/** Abort if the row stopped being ours: a project deleted or a share revoked
 * mid-render cancels its jobs, and uploading after that charges storage nothing
 * will ever free. */
async function stillRunning(jobId: string): Promise<boolean> {
  const live = await prisma.cutRenderJob.findUnique({
    where: { id: jobId },
    select: { state: true },
  });
  return live?.state === "running";
}

export async function runHlsJob(
  job: ClaimedJob,
  handle: RenderHandle
): Promise<{ outputKey: string; outName: string }> {
  const body = job.spec as ExportJobSpec;
  const spec = body?.spec;
  if (!spec || !Array.isArray(spec.clips)) throw new Error("Malformed HLS spec.");
  const projectId = job.projectId ?? spec.projectId;
  if (!projectId) throw new Error("HLS job has no project.");

  return inWorkDir(async (work) => {
    const mediaDir = await stageJobMedia(job, body, projectId, work, handle);

    // Render the master at the doc's own frame size: the ladder caps its top
    // rung at the source, so anything lost here is lost for every viewer.
    handle.outPath = path.join(work, "out", "master.mp4");
    await mkdir(path.dirname(handle.outPath), { recursive: true });
    await runExport(handle, spec, (file) => path.join(mediaDir, path.basename(file)));
    handle.progress = RENDER_SHARE;

    if (!(await stillRunning(job.id))) throw new Error("Canceled.");

    const source = await probeSource(handle.outPath);
    const ladder = planLadder(source.width, source.height);
    const outDir = path.join(work, "hls");
    await mkdir(outDir, { recursive: true });

    // A fresh tree per render: the version is a path segment, so viewers on the
    // old ladder keep playing from the edge cache while this one is written,
    // and neither can serve the other's segments.
    const version = `v${Date.now().toString(36)}`;
    const prefix = hlsPrefix(job.userId, projectId, version);

    // Claimed BEFORE any upload. The record is the only index of ladder trees,
    // so a version that started uploading without being named there would be
    // invisible to every sweep if this job then died — a whole cut's worth of
    // segments leaking with nothing left that could find them.
    await beginLadder(projectId, job.userId, version);

    const published: Variant[] = [];
    let bytes = 0;
    const passes = [ladder.slice(0, FIRST_PASS_RUNGS), ladder.slice(FIRST_PASS_RUNGS)].filter(
      (rungs) => rungs.length > 0
    );

    for (const [index, rungs] of passes.entries()) {
      // Shares of the encode budget, over the passes that actually exist: a
      // small source plans one pass, and dividing by a fixed two would leave
      // its progress stuck at the halfway mark.
      const base = RENDER_SHARE + (1 - RENDER_SHARE) * (index / passes.length);
      const span = (1 - RENDER_SHARE) / passes.length;
      const before = new Set(await listFiles(outDir).catch(() => []));

      const added = await encodeRungs(
        handle,
        handle.outPath,
        outDir,
        rungs,
        source.duration,
        (f) => {
          handle.progress = Math.min(0.99, base + span * f);
        }
      );
      if (!(await stillRunning(job.id))) throw new Error("Canceled.");

      // Upload only what this pass produced, then republish the master. The
      // master goes last on purpose: it is the file that makes segments
      // reachable, so it must never name a rung whose bytes are not up yet.
      const all = await listFiles(outDir);
      const fresh = all.filter((f) => !before.has(f) && path.basename(f) !== "master.m3u8");
      bytes += await uploadTree(outDir, prefix, fresh);

      // encodeRungs leaves behind a master describing only its own pass; the
      // merged one replaces it so every rung published so far stays listed.
      const known = new Set(published.map((v) => v.uri));
      published.push(...added.filter((v) => !known.has(v.uri)));
      await writeMaster(outDir, published);
      bytes += await uploadTree(outDir, prefix, ["master.m3u8"]);

      // Publishing after the first pass is what makes the share playable early;
      // republishing after the last keeps the record's duration and burn-in
      // flag describing the finished ladder. Unguarded: a ladder nothing can
      // point at is not a partial success, so a failed write fails the job and
      // the row carries the reason.
      await publishLadder(projectId, job.userId, {
        version,
        duration: source.duration,
        // What the render actually burned in, decided by the client from the
        // share's own grants. Recorded because captions in the pixels cannot be
        // stripped later — the server has to refuse the whole ladder instead.
        burnedSubtitles: body.burnedSubtitles === true,
      });
    }

    // No media row, and so no storage quota: a ladder is a delivery format the
    // product chose, not media the user put anywhere. They already pay for the
    // footage it was rendered from, and a share re-rendering would otherwise
    // charge them again for the same cut. It follows the same rule as the other
    // untracked bytes in this bucket (r2.ts's inference scratch): found by
    // prefix, swept by prefix, never counted.
    console.log(`[cut-worker] hls ${job.id} published ${prefix} (${bytes} bytes, untracked)`);

    return { outputKey: `${prefix}/master.m3u8`, outName: "master.m3u8" };
  });
}
