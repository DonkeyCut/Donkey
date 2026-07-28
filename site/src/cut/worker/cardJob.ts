import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { RenderHandle } from "../server/exportPipeline";
import { prisma, registerObject, type ClaimedJob } from "./db";
import { cardKey, uploadFile } from "./r2";

// The share card: what a link to a shared project unfurls with. The render
// itself is an ordinary export of the cut's opening seconds (runExportJob
// produces it); this module turns that clip into the two artifacts a social
// card needs — the true first frame as a JPEG, and an animated GIF of the
// opening. Platforms split on GIFs: some animate them, the rest fall back to
// the first frame, which is the same picture either way.

/** Animated card: small enough that no crawler refuses it, big enough to read
 * on a phone. Tried in order until one lands under MAX_GIF_BYTES. `box` is the
 * longest side, not the width — sizing a portrait cut by width gives it three
 * times the area of a landscape one at the same setting, and a GIF's size
 * tracks its area. */
const GIF_RECIPES = [
  { fps: 12, box: 600, colors: 128 },
  { fps: 10, box: 480, colors: 96 },
  { fps: 8, box: 400, colors: 64 },
];
const MAX_GIF_BYTES = 3 * 1024 * 1024;

/** ffmpeg for the derivations: short, bounded, and its own runner so the
 * engine's export pipeline keeps a single entry point. */
function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-hide_banner", "-y", ...args]);
    let tail = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-2000);
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 120_000);
    timer.unref();
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}.\n${tail}`));
    });
  });
}

async function bytesOf(file: string): Promise<number> {
  return (await stat(file)).size;
}

/** Still frame at t=0 — the video's actual first frame, not a poster picked
 * from the middle. */
async function renderStill(source: string, dest: string): Promise<number> {
  await ffmpeg(["-i", source, "-frames:v", "1", "-q:v", "3", dest]);
  return bytesOf(dest);
}

/** Animated card, stepping down through the recipes until it fits. The last
 * recipe's output ships whatever its size — a card slightly over budget beats
 * no card. */
async function renderAnimation(source: string, dest: string): Promise<number> {
  let bytes = 0;
  for (const [i, recipe] of GIF_RECIPES.entries()) {
    await ffmpeg([
      "-i",
      source,
      "-vf",
      `fps=${recipe.fps},scale=w=${recipe.box}:h=${recipe.box}:` +
        `force_original_aspect_ratio=decrease:flags=lanczos,split[s0][s1];` +
        `[s0]palettegen=max_colors=${recipe.colors}[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`,
      "-loop",
      "0",
      dest,
    ]);
    bytes = await bytesOf(dest);
    if (bytes <= MAX_GIF_BYTES || i === GIF_RECIPES.length - 1) break;
  }
  return bytes;
}

/**
 * Derive and store a project's card artifacts from the rendered opening clip.
 * Both land on fixed keys, so a re-render replaces the pair in place and the
 * project never accumulates one card per edit — the public URL carries the
 * doc version instead. Returns the key the job row records.
 */
export async function storeCardArtifacts(
  job: ClaimedJob,
  handle: RenderHandle,
  projectId: string
): Promise<{ outputKey: string; outName: string }> {
  const dir = path.dirname(handle.outPath);
  const stillPath = path.join(dir, "card.jpg");
  const animPath = path.join(dir, "card.gif");
  const stillBytes = await renderStill(handle.outPath, stillPath);
  const animBytes = await renderAnimation(handle.outPath, animPath);

  // Same guard the export path uses: a project deleted mid-render must not
  // leave storage charged for bytes nothing can free.
  const live = await prisma.cutRenderJob.findUnique({
    where: { id: job.id },
    select: { state: true },
  });
  if (live?.state !== "running") throw new Error("Canceled.");

  const stillKey = cardKey(job.userId, projectId, "jpg");
  const animKey = cardKey(job.userId, projectId, "gif");
  await Promise.all([
    uploadFile(stillKey, stillPath, "image/jpeg"),
    uploadFile(animKey, animPath, "image/gif"),
  ]);
  await registerObject({
    userId: job.userId,
    projectId,
    r2Key: stillKey,
    fileName: "card.jpg",
    mime: "image/jpeg",
    bytes: stillBytes,
    kind: "card",
  });
  await registerObject({
    userId: job.userId,
    projectId,
    r2Key: animKey,
    fileName: "card.gif",
    mime: "image/gif",
    bytes: animBytes,
    kind: "card",
  });
  return { outputKey: animKey, outName: "card.gif" };
}
