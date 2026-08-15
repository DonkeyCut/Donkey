#!/usr/bin/env bun
/**
 * Doc-only export smoke: a headless process takes a project from empty to a
 * finished mp4 with no page anywhere. It seeds a cloud project, imports a
 * real video, places a clip and a title, rasterizes the title PNG on the
 * skia server canvas, queues the export, and waits for the worker to render.
 *
 * Run with the site dev server up and a local worker running:
 *   bun run scripts/eval-cut-headless-export.ts [--base http://localhost:3000]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAiTool } from "../src/cut/lib/aiTools";
import { createExportJob, EXPORT_PRESETS, pollExport, presetSettings, type ExportDoc } from "../src/cut/lib/exportClient";
import { bindHeadlessSession, type HeadlessSession } from "../src/cut/lib/headless/bind";
import { openCloudProject, pushCloudProject } from "../src/cut/lib/headless/docSession";
import { installSkiaRaster } from "../src/cut/lib/headless/skiaRaster";
import { importFileToProject } from "../src/cut/lib/media";
import { useEditor } from "../src/cut/lib/store";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const base = arg("base") ?? "http://localhost:3000";
const session: HeadlessSession = {
  base,
  headers: { "x-donkey-client-id": "donkey-cut-eval", "x-donkey-dev-auth-bypass": "1" },
};
const api = (path: string, init?: RequestInit) =>
  fetch(base + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...session.headers, ...init?.headers },
  });
const fail = (msg: string): never => {
  process.exitCode = 1;
  throw new Error(`FAIL ${msg}`);
};

if (!(await installSkiaRaster())) fail("skia-canvas is unavailable in this process");
bindHeadlessSession(session);

const created = await api("/api/cut-cloud/projects", {
  method: "POST",
  body: JSON.stringify({ name: `headless-export-${Date.now()}` }),
});
if (!created.ok) fail(`could not create project (${created.status}) — is the dev server up?`);
const projectId = ((await created.json()) as { id: string }).id;
console.log(`seeded project ${projectId}`);

try {
  const docSession = await openCloudProject(session, projectId);

  // A real clip: one of the starter videos, imported the same way generated
  // media lands (upload, probe from the bytes in hand, store row).
  const mp4 = readFileSync(
    join(import.meta.dir, "../public/cut-starter/media/ai-watercolor-and-loose-black-ink-sketch-il.mp4")
  );
  const file = new File([new Uint8Array(mp4)], "clip.mp4", { type: "video/mp4" });
  const asset = await importFileToProject(projectId, file);
  if (!asset) fail("could not import the starter video");
  useEditor.getState().addAsset(asset!);
  await runAiTool("add_clip", { asset_id: asset!.id });
  await runAiTool("add_title", { text: "HEADLESS EXPORT", start: 0 });
  const s = useEditor.getState();
  console.log(`timeline: ${s.clips.length} clip(s), ${s.overlays.length} overlay(s)`);

  await pushCloudProject(session, docSession);
  const doc = useEditor.getState();
  const exportDoc: ExportDoc = {
    aspect: doc.aspect,
    assets: doc.assets,
    clips: doc.clips,
    audioClips: doc.audioClips,
    overlays: doc.overlays,
    subtitles: doc.subtitles,
    fadeIn: doc.fadeIn,
    fadeOut: doc.fadeOut,
  };
  const settings = presetSettings(EXPORT_PRESETS[2], doc.aspect);
  const jobId = await createExportJob(projectId, exportDoc, settings);
  console.log(`queued export ${jobId} — waiting on the worker`);

  let lastLogged = -1;
  const onProgress = (_stage: string, ratio: number) => {
    const pct = Math.round(ratio * 100);
    if (pct >= lastLogged + 20) {
      lastLogged = pct;
      console.log(`  rendering ${pct}%`);
    }
  };
  const outName = await pollExport(jobId, onProgress);
  console.log(`PASS export finished: ${outName}`);
} finally {
  await api(`/api/cut-cloud/projects/${projectId}`, { method: "DELETE" });
}
