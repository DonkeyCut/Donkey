#!/usr/bin/env bun
/**
 * Keyboard-after-a-drop eval: does the editor answer the keys right after a
 * library card lands on the timeline?
 *
 * The editor is played from the keyboard, and the moment after a drop is where
 * it went quiet once: a drag fires no pointer events, so the skimmer stayed
 * wherever it was before the drag and ⌘B cut nothing, and a composer that held
 * the focus before the drag kept it through the drop and swallowed the ⌫. Each
 * case here performs the real gesture in a headless Chrome against the dev
 * server — the library shelf, the drag, the drop, the keystroke — and reads the
 * document back through the dev hooks. Any key that goes nowhere fails the run.
 *
 * Needs `next dev` on :3000, the dev auth bypass user, and `ffmpeg` on the
 * PATH for the fixture clip.
 *
 *   npm run eval:cut-keys [--base url] [--headed] [--out path]
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Locator, type Page } from "playwright";

const SITE = path.resolve(import.meta.dir, "..");
const REPORT = path.resolve(SITE, "..", "evals", "cut-keys.latest-report.json");

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);
const BASE = arg("--base") ?? "http://localhost:3000";
const OUT = arg("--out") ?? REPORT;

/** The dev-only account the API bypass authenticates as. */
const DEV_USER = "donkey-dev-auth-bypass";
const PROJECT_NAME = "cut-keys eval";
const CLIP_S = 4;

interface Snapshot {
  clips: { id: string; start: number; in: number; out: number }[];
  selection: { kind: string; id: string } | null;
  active: string;
}

interface CaseResult {
  name: string;
  what: string;
  ok: boolean;
  detail: string;
}

// ── Fixture ─────────────────────────────────────────────────────────────────

async function fixture(): Promise<string> {
  const dir = path.join(tmpdir(), "cut-keys-eval");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "clip.mp4");
  await promisify(execFile)("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc=size=640x360:rate=30`,
    "-f", "lavfi", "-i", "sine=frequency=440",
    "-t", String(CLIP_S),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    file,
  ]);
  return file;
}

// ── The account's shelf and project ─────────────────────────────────────────

async function newProject(): Promise<string> {
  const res = await fetch(`${BASE}/api/cut/projects?u=${DEV_USER}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: PROJECT_NAME }),
  });
  if (!res.ok) throw new Error(`create project failed: ${res.status} (is next dev running?)`);
  return ((await res.json()) as { id: string }).id;
}

async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/cut/projects/${id}?u=${DEV_USER}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) console.log(`[cleanup] delete project ${id} failed: ${res.status}`);
}

/** Put the fixture on the library shelf, and hand back its id for cleanup. */
async function shelve(file: string): Promise<string> {
  const form = new FormData();
  form.set("file", new File([await readFile(file)], "cut-keys-eval.mp4", { type: "video/mp4" }));
  const res = await fetch(`${BASE}/api/cut/library?u=${DEV_USER}`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`library upload failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function unshelve(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/cut/library/${id}?u=${DEV_USER}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) console.log(`[cleanup] delete library ${id} failed: ${res.status}`);
}

/** Remove what a crashed run left behind: its projects and its shelf copies. */
async function sweep(): Promise<void> {
  const projects = await fetch(`${BASE}/api/cut/projects?u=${DEV_USER}`);
  if (projects.ok) {
    const stale = ((await projects.json()) as { id: string; name: string }[]).filter((p) => p.name === PROJECT_NAME);
    for (const p of stale) await deleteProject(p.id);
  }
  const library = await fetch(`${BASE}/api/cut/library?u=${DEV_USER}`);
  if (library.ok) {
    const { assets = [] } = (await library.json()) as { assets?: { id: string; name: string }[] };
    for (const a of assets.filter((x) => x.name === "cut-keys-eval.mp4")) await unshelve(a.id);
  }
}

// ── The page ────────────────────────────────────────────────────────────────

async function launch() {
  const browser = await chromium.launch({ channel: "chrome", headless: !has("--headed") });
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-donkey-dev-auth-bypass": "1" },
    viewport: { width: 1600, height: 1000 },
  });
  // The editor's session gate is a client-side cookie read, and the only
  // sign-in this build offers is Google's. Answering that one request for the
  // dev-bypass user is the whole of the fake; every other request is real.
  await context.route("**/api/auth/get-session*", async (route) => {
    const stamp = new Date(0).toISOString();
    const user = {
      id: DEV_USER,
      name: "cut-keys eval",
      email: "cut-keys@localhost",
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
          id: "cut-keys-session",
          userId: DEV_USER,
          token: "cut-keys",
          expiresAt: new Date(Date.now() + 864e5).toISOString(),
          createdAt: stamp,
          updatedAt: stamp,
        },
      }),
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${String(e).slice(0, 200)}`));
  return { browser, page };
}

async function open(page: Page, projectId: string): Promise<void> {
  await page.goto(`${BASE}/app/p/${projectId}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __cutDev?: { useEditor: { getState(): { loaded: boolean } } } };
      return !!w.__cutDev && w.__cutDev.useEditor.getState().loaded;
    },
    undefined,
    { timeout: 120_000 }
  );
}

const snapshot = (page: Page) =>
  page.evaluate((): Snapshot => {
    const w = window as unknown as {
      __cutDev: { useEditor: { getState(): { clips: Snapshot["clips"]; selection: Snapshot["selection"] } } };
    };
    const s = w.__cutDev.useEditor.getState();
    const ae = document.activeElement;
    return {
      clips: s.clips.map((c) => ({ id: c.id, start: c.start, in: c.in, out: c.out })),
      selection: s.selection ? { kind: s.selection.kind, id: s.selection.id } : null,
      active: ae ? ae.tagName : "",
    };
  });

/** Empty the timeline between cases without touching the shelf. */
const clear = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __cutDev: { useEditor: { setState(p: unknown): void } };
    };
    w.__cutDev.useEditor.setState({ clips: [], selection: null, multiSelection: [] });
  });

/** Bring the Library sub-tab of the Media panel up and hand back the card. */
async function libraryCard(page: Page): Promise<Locator> {
  const tab = page.getByText("Library", { exact: true }).first();
  if (!(await tab.isVisible().catch(() => false))) {
    await page.getByText("Media", { exact: true }).first().click();
    await tab.waitFor({ state: "visible", timeout: 10_000 });
  }
  await tab.click();
  const card = page.locator("[data-sel-id]").filter({ hasText: "cut-keys-eval" }).first();
  await card.waitFor({ state: "visible", timeout: 30_000 });
  return card;
}

/** The real gesture: drag the card onto track 0 and wait for the clip to land.
 * The mouse stays where the drop left it — the case is what the keys do from
 * exactly there. */
async function dropOnTrack(page: Page, card: Locator): Promise<Snapshot> {
  const surface = page.locator("[data-segment-drop]").first();
  const box = await surface.boundingBox();
  if (!box) throw new Error("no timeline drop surface");
  await card.dragTo(surface, { targetPosition: { x: 160, y: box.height - 60 } });
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __cutDev: { useEditor: { getState(): { clips: unknown[] } } } };
      return w.__cutDev.useEditor.getState().clips.length > 0;
    },
    undefined,
    { timeout: 30_000 }
  );
  await page.waitForTimeout(300);
  return snapshot(page);
}

async function press(page: Page, key: string): Promise<Snapshot> {
  await page.keyboard.press(key);
  await page.waitForTimeout(200);
  return snapshot(page);
}

// ── Cases ───────────────────────────────────────────────────────────────────

interface Spec {
  name: string;
  what: string;
  run: (page: Page, card: Locator) => Promise<string | null>;
}

const CASES: Spec[] = [
  {
    name: "drop/selected",
    what: "the clip that lands is the selection",
    run: async (page, card) => {
      const s = await dropOnTrack(page, card);
      if (s.clips.length !== 1) return `${s.clips.length} clips landed`;
      if (s.selection?.kind !== "clip" || s.selection.id !== s.clips[0].id) return `selection ${JSON.stringify(s.selection)}`;
      return null;
    },
  },
  {
    name: "drop/split",
    what: "⌘B with the mouse still where it dropped cuts the new clip",
    run: async (page, card) => {
      await dropOnTrack(page, card);
      const s = await press(page, "Meta+b");
      if (s.clips.length !== 2) return `${s.clips.length} clips after ⌘B`;
      if (s.selection?.id !== s.clips[1].id) return `selection ${JSON.stringify(s.selection)} after ⌘B`;
      return null;
    },
  },
  {
    name: "drop/delete",
    what: "⌫ right after the drop removes the clip that landed",
    run: async (page, card) => {
      await dropOnTrack(page, card);
      const s = await press(page, "Backspace");
      if (s.clips.length !== 0) return `${s.clips.length} clips after ⌫`;
      return null;
    },
  },
  {
    name: "drop/typing",
    what: "a chat composer focused before the drag lets go of the keys at the drop",
    run: async (page, card) => {
      await press(page, "Meta+j");
      const composer = page.locator("textarea.ai-input").first();
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await composer.click();
      const before = await snapshot(page);
      if (before.active !== "TEXTAREA") return `composer never took the focus (${before.active})`;
      const landed = await dropOnTrack(page, card);
      const s = await press(page, "Delete");
      if (s.clips.length !== 0) return `${s.clips.length} clips after Delete with ${landed.active} focused`;
      const again = await dropOnTrack(page, card);
      const cut = await press(page, "Meta+b");
      if (cut.clips.length !== 2) return `${cut.clips.length} clips after ⌘B with ${again.active} focused`;
      await press(page, "Meta+j");
      return null;
    },
  },
];

// ── Run ─────────────────────────────────────────────────────────────────────

await sweep();
const file = await fixture();
const libraryId = await shelve(file);
const projectId = await newProject();
const results: CaseResult[] = [];
const { browser, page } = await launch();
try {
  await open(page, projectId);
  const card = await libraryCard(page);
  for (const spec of CASES) {
    await clear(page);
    await page.mouse.move(900, 400);
    let detail: string | null;
    try {
      detail = await spec.run(page, card);
    } catch (e) {
      detail = String(e).slice(0, 300);
    }
    const ok = detail === null;
    results.push({ name: spec.name, what: spec.what, ok, detail: detail ?? "" });
    console.log(`[${ok ? "ok" : "FAIL"}] ${spec.name} — ${spec.what}${ok ? "" : `: ${detail}`}`);
  }
} finally {
  await browser.close();
  await deleteProject(projectId);
  await unshelve(libraryId);
}

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed · ${OUT}`);
process.exit(failed ? 1 : 0);
