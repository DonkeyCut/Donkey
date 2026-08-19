#!/usr/bin/env bun
/**
 * Browser export eval: the render path a browser-resident (and cloud) project
 * takes — framePlan, FrameCompositor, WebCodecs, the mediabunny muxer, the
 * audio mix — driven end to end in a real Chrome.
 *
 * A fixture project using the renderer's features (cover framing with zoom and
 * pan, a transition, playback speed, a grade, a keyframed pose, a
 * picture-in-picture track, a text element, burned-in captions, a music bed
 * with fades, whole-video fades, a background color) renders through the same
 * `renderProjectToMp4` the export dock calls, and the resulting MP4 is pulled
 * back out and ffprobed: right duration, right dimensions, both streams.
 *
 * Needs `next dev` on :3000. Spends no credits.
 *
 *   npm run eval:cut-export [--headed] [--base URL] [--hermetic]
 *
 * `--hermetic` answers every API call inside the browser context — the doc
 * GET with an empty project, the rest with empty stubs — so the run needs no
 * database and no real account. CI runs this mode against a `next dev` booted
 * on placeholder env values; the page shell is the only thing the server
 * serves.
 */

import { chromium, type Browser, type Page } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE = path.resolve(import.meta.dir, "..");
const OUT = path.resolve(SITE, "..", "dist", "cut-export");
const STOCK = path.join(SITE, "public", "cut-stock-video");

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const BASE = arg("--base") ?? "http://localhost:3000";
const HERMETIC = has("--hermetic");
/** The dev-only account the API bypass authenticates as. */
const DEV_USER = "donkey-dev-auth-bypass";
/** The project id a hermetic run opens; its doc is answered in-context. */
const HERMETIC_PROJECT = "cut-export-eval";

const CLIP_S = 3;
/** How far the probed file may drift from the doc's own duration. */
const DURATION_TOLERANCE_S = 0.5;

function run(cmd: string, cmdArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`));
      resolve(out);
    });
  });
}

/** Fixture clips re-encoded from the bundled stock video, with a sine tone as
 * audio so the mix has something real to carry, plus a music bed. */
async function buildFixtures(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const sources = [
    "animal-dog-sprint.mp4",
    "animal-flock-sky.mp4",
  ].filter((f) => existsSync(path.join(STOCK, f)));
  if (sources.length === 0) throw new Error(`no stock clips found in ${STOCK}`);

  for (let i = 0; i < 2; i++) {
    const dst = path.join(OUT, `clip-${i}.mp4`);
    if (existsSync(dst)) continue;
    await run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", path.join(STOCK, sources[i % sources.length]),
      "-f", "lavfi", "-i", `sine=frequency=${440 * (i + 1)}:sample_rate=44100:duration=${CLIP_S}`,
      "-t", String(CLIP_S),
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-preset", "veryfast", "-r", "30",
      "-vf", "scale=1280:-2", "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      dst,
    ]);
  }
  const music = path.join(OUT, "music.m4a");
  if (!existsSync(music)) {
    await run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=8",
      "-c:a", "aac",
      music,
    ]);
  }
}

/** A browser with the fixture media served from disk and the session answered. */
async function launch(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: !has("--headed"),
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-donkey-dev-auth-bypass": "1" },
    viewport: { width: 1600, height: 1000 },
  });
  if (HERMETIC) {
    // Registered first, so the specific routes below win: everything else
    // under /api answers as an empty stub and the server is never asked. The
    // engine's port answers nothing at all, so the residency probe resolves
    // the project to the cloud the way a machine without the app would.
    await context.route("**/api/**", (route, request) => {
      if (new URL(request.url()).port === "41417") return route.abort();
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    // "Nothing saved yet" — the onboarding gate reads this and steps aside.
    await context.route("**/api/account/onboarding", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "null" })
    );
    await context.route(
      (u) => /\/api\/(cut|cut-cloud)\/(projects|export-jobs|library)$/.test(u.pathname),
      (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    );
    await context.route(
      (u) => new RegExp(`/api/(cut|cut-cloud)/projects/${HERMETIC_PROJECT}$`).test(u.pathname),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "x-cut-doc-version": "1" },
          body: JSON.stringify({
            name: "cut-export eval",
            assets: [],
            clips: [],
            audioClips: [],
            overlays: [],
          }),
        })
    );
  }
  await context.route("**/api/auth/get-session*", async (route) => {
    const stamp = new Date(0).toISOString();
    const user = {
      id: DEV_USER,
      name: "cut-export eval",
      email: "cut-export@localhost",
      emailVerified: true,
      createdAt: stamp,
      updatedAt: stamp,
      image: null,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user,
        session: {
          id: "cut-export-session",
          userId: DEV_USER,
          token: "cut-export",
          expiresAt: new Date(Date.now() + 864e5).toISOString(),
          createdAt: stamp,
          updatedAt: stamp,
        },
      }),
    });
  });
  await context.route("**/__cutexport/*", async (route, request) => {
    const name = path.basename(new URL(request.url()).pathname);
    const body = await readFile(path.join(OUT, name));
    const type = name.endsWith(".m4a") ? "audio/mp4" : "video/mp4";
    await route.fulfill({ status: 200, contentType: type, body });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${String(e).slice(0, 200)}`));
  page.on("crash", () => console.log("[crash] the page went down"));
  return { browser, page };
}

async function open(page: Page, projectId: string): Promise<void> {
  await page.goto(`${BASE}/app/p/${projectId}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __cutDev?: { useEditor: { getState(): { loaded: boolean } } };
      };
      return !!w.__cutDev && w.__cutDev.useEditor.getState().loaded;
    },
    undefined,
    { timeout: 120_000 }
  );
}

/** Render the fixture doc in the tab and hand the MP4 bytes back. */
async function renderInPage(page: Page): Promise<{ b64: string; duration: number }> {
  return page.evaluate(
    async ({ clipS }) => {
      const dev = (window as unknown as {
        __cutDev: {
          renderProjectToMp4: (
            doc: unknown,
            settings: unknown,
            opts: { resolve: (a: { url: string }) => string }
          ) => Promise<{ file: Blob; discard(): Promise<void> }>;
          projectDuration: (doc: unknown) => number;
        };
      }).__cutDev;

      const asset = (id: string, file: string, type: string, duration: number) => ({
        id,
        fileName: file,
        name: id,
        type,
        url: `/__cutexport/${file}`,
        duration,
        ...(type === "video" ? { width: 1280, height: 720 } : {}),
      });
      const doc = {
        aspect: "16:9",
        background: "#102030",
        fadeIn: 0.3,
        fadeOut: 0.3,
        assets: [
          asset("v0", "clip-0.mp4", "video", clipS),
          asset("v1", "clip-1.mp4", "video", clipS),
          asset("m0", "music.m4a", "audio", 8),
        ],
        clips: [
          {
            id: "c0", assetId: "v0", track: 0, start: 0, in: 0, out: clipS,
            muted: false, volume: 0.8,
            fit: "fill", zoom: 1.4, panX: 0.3, panY: -0.2,
            speed: 1.25,
            transition: 0.5, transitionStyle: "crossfade",
          },
          {
            id: "c1", assetId: "v1", track: 0, start: clipS / 1.25, in: 0, out: clipS,
            muted: false,
            fit: "fit",
            grade: { brightness: 5, contrast: 8, saturation: -10, temperature: 12, hue: 10 },
            kf: [
              { t: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 },
              { t: 2, x: 0.6, y: 0.4, scale: 0.85, rotation: 12, opacity: 1 },
            ],
          },
          {
            id: "c2", assetId: "v0", track: 1, start: 1, in: 0, out: 1.5,
            muted: true,
            frame: { x: 0.55, y: 0.05, w: 0.4, h: 0.4 },
            fit: "fill", rotation: 5, opacity: 0.9,
          },
        ],
        audioClips: [
          {
            id: "a0", assetId: "m0", start: 0, in: 0, out: 5,
            volume: 0.5, fadeIn: 0.3, fadeOut: 0.5, lane: 0,
          },
        ],
        overlays: [
          {
            id: "t0", kind: "text", text: "Everything test",
            start: 0.5, end: 3, x: 0.5, y: 0.2, lane: 0,
            size: 64, font: "sf", weight: 700, color: "#FFFFFF",
            shadow: true, plate: true,
          },
        ],
        subtitles: {
          cues: [
            { id: "s0", start: 0.3, end: 1.2, text: "every feature" },
            { id: "s1", start: 1.4, end: 2.2, text: "in one render" },
          ],
          showOnVideo: true,
          showOnTimeline: false,
        },
      };
      const settings = { width: 1280, height: 720, fps: 24, crf: 24, preset: "veryfast" };

      const duration = dev.projectDuration(doc);
      const rendered = await dev.renderProjectToMp4(doc, settings, {
        resolve: (a) => a.url,
      });
      const bytes = new Uint8Array(await rendered.file.arrayBuffer());
      await rendered.discard();
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      return { b64: btoa(bin), duration };
    },
    { clipS: CLIP_S }
  );
}

async function main(): Promise<void> {
  await buildFixtures();
  console.log(`[fixtures] ready in ${OUT}`);

  const { browser, page } = await launch();
  let projectId = HERMETIC_PROJECT;
  if (!HERMETIC) {
    const res = await fetch(`${BASE}/api/cut/projects?u=${DEV_USER}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "cut-export eval" }),
    });
    if (!res.ok) throw new Error(`create project failed: ${res.status} (is next dev running?)`);
    projectId = ((await res.json()) as { id: string }).id;
  }
  console.log(`[ready] ${BASE}/app/p/${projectId}${HERMETIC ? " (hermetic)" : ""}`);

  await open(page, projectId);
  const t0 = Date.now();
  const { b64, duration } = await renderInPage(page);
  await browser.close();

  const outPath = path.join(OUT, "export.mp4");
  await writeFile(outPath, Buffer.from(b64, "base64"));
  console.log(`[render] ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outPath}`);

  const probed = JSON.parse(
    await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-show_entries", "stream=codec_type,width,height",
      "-of", "json",
      outPath,
    ])
  ) as {
    format: { duration: string };
    streams: { codec_type: string; width?: number; height?: number }[];
  };

  const failures: string[] = [];
  const got = Number(probed.format.duration);
  if (!(Math.abs(got - duration) <= DURATION_TOLERANCE_S)) {
    failures.push(`duration ${got.toFixed(2)}s, doc says ${duration.toFixed(2)}s`);
  }
  const video = probed.streams.find((s) => s.codec_type === "video");
  if (video?.width !== 1280 || video?.height !== 720) {
    failures.push(`picture is ${video?.width}x${video?.height}, settings say 1280x720`);
  }
  if (!probed.streams.some((s) => s.codec_type === "audio")) {
    failures.push("no audio stream");
  }

  if (failures.length) {
    console.error(`[FAIL] ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log(`[ok] ${got.toFixed(2)}s, 1280x720, video+audio`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
