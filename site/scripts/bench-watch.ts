/**
 * Watch-selection benchmark: how well does each frame-selection method turn a
 * video into ≤36 contact-sheet cells?
 *
 * Methods, both fed the same candidate pass (the production sampler's steady
 * floor at max(1s, duration/150), software decode for determinism):
 *   A  fixed interval — the old sampler: steady clamp(range/32, 2, 30)s
 *   C  dense+dedup    — the shipped selector (lib/watch/dedupSelector)
 *
 * Fixtures build deterministically into dist/watch-bench/ (gitignored):
 *   montage    — 20 stock clips re-encoded and concatenated; ground truth =
 *                the known cut times (does each segment get a frame?)
 *   slideshow  — synthesized text cards on a static background; ground truth =
 *                the card-change times (the settled-channel case: thin strokes
 *                that measure ~0% on a coarse grid)
 *   talking heads — stock character clips as-is (dedup should collapse these)
 *   jfk-rice   — public-domain speech footage via yt-dlp when available
 *
 * Outputs: dist/watch-bench/stats.csv, per-video keep/drop report.html for
 * method C, candidate JPEGs for eyeballing. Run: npx bun scripts/bench-watch.ts
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createDedupSelector } from "../src/cut/lib/watch/dedupSelector";
import { SIGNATURE_SIZE, type FrameDecision } from "../src/cut/lib/watch/types";

const SITE = path.resolve(import.meta.dir, "..");
const OUT = path.resolve(SITE, "..", "dist", "watch-bench");
const STOCK = path.join(SITE, "public", "cut-stock-video");
const RAW_BYTES = SIGNATURE_SIZE * SIGNATURE_SIZE * 3;
const MAX_KEPT = 36;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface RunOut {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

function run(cmd: string, args: string[], onStdout?: (d: Buffer) => void): Promise<RunOut> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const chunks: Buffer[] = [];
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (onStdout ? onStdout(d) : chunks.push(d)));
    p.stderr.on("data", (d) => {
      if (stderr.length < 4_000_000) stderr += d.toString();
    });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks), stderr }));
  });
}

async function ffmpeg(args: string[], onStdout?: (d: Buffer) => void): Promise<RunOut> {
  const r = await run("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args], onStdout);
  if (r.code !== 0 && !onStdout)
    throw new Error(`ffmpeg failed: ${r.stderr.split("\n").slice(-4).join("\n")}`);
  return r;
}

// ---------------------------------------------------------------- fixtures

/** Deterministic PRNG so the slideshow renders identically every run. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}

const CARD_W = 640;
const CARD_H = 360;
const CARD_SECONDS = 6;
const CARD_COUNT = 8;

/** One text card as a PPM (P6) buffer: a block digit header plus rows of
 * 2px "text" strokes whose lengths change per card — thin ink on a static
 * background, the change a coarse grid cannot see. */
function renderCard(card: number): Buffer {
  const px = new Uint8Array(CARD_W * CARD_H * 3);
  for (let i = 0; i < px.length; i += 3) {
    px[i] = 16;
    px[i + 1] = 16;
    px[i + 2] = 20;
  }
  const fill = (x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h && yy < CARD_H; yy++)
      for (let xx = x; xx < x + w && xx < CARD_W; xx++) {
        const i = (yy * CARD_W + xx) * 3;
        px[i] = 235;
        px[i + 1] = 235;
        px[i + 2] = 240;
      }
  };
  // Seven-segment "chapter" digit, so sheets are eyeball-checkable. It only
  // advances every second card — the in-between transitions change nothing
  // but the 2px stroke rows, the change only the settled channel can see.
  const SEGS: Record<string, [number, number, number, number]> = {
    top: [0, 0, 60, 8],
    mid: [0, 46, 60, 8],
    bot: [0, 92, 60, 8],
    tl: [0, 0, 8, 50],
    tr: [52, 0, 8, 50],
    bl: [0, 50, 8, 50],
    br: [52, 50, 8, 50],
  };
  const DIGIT: Record<number, string[]> = {
    0: ["top", "bot", "tl", "tr", "bl", "br"],
    1: ["tr", "br"],
    2: ["top", "mid", "bot", "tr", "bl"],
    3: ["top", "mid", "bot", "tr", "br"],
    4: ["mid", "tl", "tr", "br"],
    5: ["top", "mid", "bot", "tl", "br"],
    6: ["top", "mid", "bot", "tl", "bl", "br"],
    7: ["top", "tr", "br"],
    8: ["top", "mid", "bot", "tl", "tr", "bl", "br"],
    9: ["top", "mid", "bot", "tl", "tr", "br"],
  };
  for (const seg of DIGIT[(Math.floor(card / 2) + 1) % 10]) {
    const [x, y, w, h] = SEGS[seg];
    fill(40 + x, 30 + y, w, h);
  }
  // "Body text": a seeded paragraph of thin word-run strokes. Line pitch,
  // word lengths, and gaps are the card's identity — different text lays its
  // ink at different spots, the way real caption swaps do.
  const rand = lcg(1000 + card * 77);
  const lineH = 14 + Math.floor(rand() * 9);
  const lines = 7 + Math.floor(rand() * 4);
  for (let row = 0; row < lines; row++) {
    const y = 160 + row * lineH + Math.floor(rand() * 4);
    let x = 40 + Math.floor(rand() * 30);
    while (x < 560) {
      const w = 20 + Math.floor(rand() * 60);
      if (rand() > 0.25) fill(x, y, Math.min(w, 580 - x), 3);
      x += w + 8 + Math.floor(rand() * 18);
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${CARD_W} ${CARD_H}\n255\n`), Buffer.from(px)]);
}

const WRITE_SECONDS = 40;
const WRITE_STEP = 2; // a new word-run lands every 2s
// One page for the whole clip: a cleared page would leave the old full page
// in the selector's kept window, sitting exactly where the new ink lands —
// the window's changed-vs-everything rule then reads the new ink as already
// seen. Page swaps are a hard-cut case; the montage covers those.
const WRITE_PAGE = WRITE_SECONDS;

/** One second of the "handwriting" fixture: dark word-runs accumulating on a
 * bright static page, one more every WRITE_STEP seconds — a slow thin-stroke
 * morph, the settled channel's hardest case. */
function renderWritingFrame(sec: number): Buffer {
  const px = new Uint8Array(CARD_W * CARD_H * 3);
  for (let i = 0; i < px.length; i += 3) {
    px[i] = 235;
    px[i + 1] = 233;
    px[i + 2] = 225;
  }
  const ink = (x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h && yy < CARD_H; yy++)
      for (let xx = x; xx < x + w && xx < CARD_W; xx++) {
        const i = (yy * CARD_W + xx) * 3;
        px[i] = 30;
        px[i + 1] = 28;
        px[i + 2] = 40;
      }
  };
  const page = Math.floor(sec / WRITE_PAGE);
  const steps = Math.floor((sec % WRITE_PAGE) / WRITE_STEP) + 1;
  const rand = lcg(4000 + page * 131);
  let x = 60;
  let y = 60;
  for (let s = 0; s < steps; s++) {
    const w = 40 + Math.floor(rand() * 90);
    if (x + w > 580) {
      x = 60;
      y += 24 + Math.floor(rand() * 6);
    }
    ink(x, y, w, 3);
    x += w + 14 + Math.floor(rand() * 12);
  }
  return Buffer.concat([Buffer.from(`P6\n${CARD_W} ${CARD_H}\n255\n`), Buffer.from(px)]);
}

interface Fixture {
  slug: string;
  file: string;
  /** Ground-truth state boundaries (ascending): a good selection has ≥1 kept
   * frame inside every [boundary[i], boundary[i+1]) span. */
  states?: number[];
}

async function buildFixtures(): Promise<Fixture[]> {
  const fx = path.join(OUT, "fixtures");
  await mkdir(fx, { recursive: true });
  const fixtures: Fixture[] = [];

  // montage: 20 stock clips, 7s each, one size, concatenated. Real encoded
  // part durations drift from the asked-for 7s, so the ground-truth cut
  // times are measured, then remembered beside the file.
  const montage = path.join(fx, "montage.mp4");
  const montageStates = path.join(fx, "montage.states.json");
  const stock = (await readdir(STOCK)).filter((f) => f.endsWith(".mp4")).sort().slice(0, 20);
  if (!existsSync(montage) || !existsSync(montageStates)) {
    const parts: string[] = [];
    const cuts: number[] = [];
    let at = 0;
    for (const [i, f] of stock.entries()) {
      const part = path.join(fx, `part-${String(i).padStart(2, "0")}.ts`);
      await ffmpeg([
        "-ss", "0", "-t", "7", "-i", path.join(STOCK, f),
        "-vf", "scale=640:360:force_original_aspect_ratio=increase,crop=640:360,fps=30",
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", part,
      ]);
      parts.push(part);
      cuts.push(at);
      const probe = await run("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", part,
      ]);
      at += parseFloat(probe.stdout.toString()) || 7;
    }
    const list = path.join(fx, "concat.txt");
    await writeFile(list, parts.map((p) => `file '${p}'`).join("\n"));
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", montage]);
    await writeFile(montageStates, JSON.stringify(cuts));
    await Promise.all(parts.map((p) => rm(p, { force: true })));
    await rm(list, { force: true });
  }
  fixtures.push({
    slug: "montage",
    file: montage,
    states: JSON.parse(await Bun.file(montageStates).text()) as number[],
  });

  // slideshow: synthesized text cards, CARD_SECONDS each.
  const slideshow = path.join(fx, "slideshow.mp4");
  if (!existsSync(slideshow)) {
    for (let c = 0; c < CARD_COUNT; c++)
      await writeFile(path.join(fx, `card-${String(c).padStart(3, "0")}.ppm`), renderCard(c));
    await ffmpeg([
      "-framerate", `1/${CARD_SECONDS}`, "-i", path.join(fx, "card-%03d.ppm"),
      "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      slideshow,
    ]);
    for (let c = 0; c < CARD_COUNT; c++)
      await rm(path.join(fx, `card-${String(c).padStart(3, "0")}.ppm`), { force: true });
  }
  fixtures.push({
    slug: "slideshow",
    file: slideshow,
    states: Array.from({ length: CARD_COUNT }, (_, i) => i * CARD_SECONDS),
  });

  // handwriting: ink accumulating on a static page.
  const writing = path.join(fx, "writing.mp4");
  if (!existsSync(writing)) {
    for (let s = 0; s < WRITE_SECONDS; s++)
      await writeFile(path.join(fx, `write-${String(s).padStart(3, "0")}.ppm`), renderWritingFrame(s));
    await ffmpeg([
      "-framerate", "1", "-i", path.join(fx, "write-%03d.ppm"),
      "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      writing,
    ]);
    for (let s = 0; s < WRITE_SECONDS; s++)
      await rm(path.join(fx, `write-${String(s).padStart(3, "0")}.ppm`), { force: true });
  }
  fixtures.push({
    slug: "writing",
    file: writing,
    states: Array.from({ length: WRITE_SECONDS / WRITE_STEP }, (_, i) => i * WRITE_STEP),
  });

  // talking heads: character clips as-is (no ground truth — the measure is
  // how few frames a static speaker costs).
  for (const slug of ["character-cafe-analyst", "character-startup-founder"]) {
    const file = path.join(STOCK, `${slug}.mp4`);
    if (existsSync(file)) fixtures.push({ slug, file });
  }

  // jfk-rice: public-domain speech footage (1962), 60–240s section.
  const jfk = path.join(fx, "jfk-rice.mp4");
  if (!existsSync(jfk)) {
    const probe = await run("yt-dlp", ["--version"]).catch(() => null);
    if (probe && probe.code === 0) {
      console.log("fetching jfk-rice.mp4 (yt-dlp)...");
      const dl = await run("yt-dlp", [
        "--download-sections", "*60-240",
        "-f", "bv*[height<=480]+ba/b[height<=480]",
        "--merge-output-format", "mp4",
        "-o", jfk,
        "https://www.youtube.com/watch?v=WZyRbnpGyzQ",
      ]);
      if (dl.code !== 0) console.log("  jfk-rice download failed — skipping that fixture");
    } else {
      console.log("yt-dlp not found — skipping the jfk-rice fixture");
    }
  }
  if (existsSync(jfk)) fixtures.push({ slug: "jfk-rice", file: jfk });

  return fixtures;
}

// ---------------------------------------------------- candidate extraction

interface Candidate {
  t: number;
  jpg: string; // path on disk
  raw: Uint8Array;
}

/** The production candidate pass (software decode): a steady floor at
 * max(1s, duration/150), split into 480px JPEGs and raw selector frames. */
async function extractCandidates(file: string, dir: string): Promise<{ cands: Candidate[]; ms: number }> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const probe = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  const dur = parseFloat(probe.stdout.toString()) || 0;
  const interval = Math.max(1, dur / 150);
  const graph = [
    // showinfo sits after select, so its log lines are exactly the emitted
    // candidates in order — the only place the source timestamps survive.
    `[0:v]select='isnan(prev_selected_t)+gte(t-prev_selected_t,${interval})',` +
      "showinfo,split=2[jl][rl]",
    "[jl]scale=480:-2[jpg]",
    `[rl]scale=${SIGNATURE_SIZE}:${SIGNATURE_SIZE}:flags=area,format=rgb24[raw]`,
  ].join(";");
  const raws: Uint8Array[] = [];
  let pendingBuf: Buffer = Buffer.alloc(0);
  const t0 = performance.now();
  const r = await ffmpeg(
    [
      "-loglevel", "info",
      "-i", file,
      "-filter_complex", graph,
      "-map", "[jpg]", "-fps_mode", "vfr", "-frames:v", "700", "-q:v", "5",
      path.join(dir, "cand-%04d.jpg"),
      "-map", "[raw]", "-fps_mode", "vfr", "-frames:v", "700", "-f", "rawvideo", "pipe:1",
    ],
    (d) => {
      pendingBuf = pendingBuf.length === 0 ? d : Buffer.concat([pendingBuf, d]);
      while (pendingBuf.length >= RAW_BYTES) {
        raws.push(new Uint8Array(pendingBuf.subarray(0, RAW_BYTES)));
        pendingBuf = Buffer.from(pendingBuf.subarray(RAW_BYTES));
      }
    }
  );
  const ms = performance.now() - t0;
  if (r.code !== 0) throw new Error(`candidate pass failed: ${r.stderr.split("\n").slice(-4).join("\n")}`);
  const meta: { t: number }[] = [];
  for (const line of r.stderr.split("\n")) {
    const t = /Parsed_showinfo.*pts_time:\s*(-?[\d.]+)/.exec(line);
    if (t) meta.push({ t: Math.max(0, parseFloat(t[1])) });
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
  const n = Math.min(files.length, meta.length, raws.length);
  const cands: Candidate[] = [];
  for (let i = 0; i < n; i++) cands.push({ t: meta[i].t, jpg: files[i], raw: raws[i] });
  return { cands, ms };
}

// ----------------------------------------------------------------- methods

/** A: the old cloud sampler — one frame per steady interval, capped at 36. */
function methodA(cands: Candidate[], from: number, to: number): number[] {
  const interval = clamp((to - from) / 32, 2, 30);
  const kept: number[] = [];
  for (let t = from; t < to && kept.length < MAX_KEPT; t += interval) {
    let best = -1;
    for (let i = 0; i < cands.length; i++) {
      if (best === -1 || Math.abs(cands[i].t - t) < Math.abs(cands[best].t - t)) best = i;
    }
    if (best >= 0 && kept[kept.length - 1] !== best) kept.push(best);
  }
  return kept;
}

/** C: the shipped selector. */
function methodC(cands: Candidate[]): { kept: number[]; decisions: FrameDecision[]; ms: number } {
  const t0 = performance.now();
  const selector = createDedupSelector({ maxFrames: MAX_KEPT });
  for (const c of cands)
    selector.push({ width: SIGNATURE_SIZE, height: SIGNATURE_SIZE, channels: 3, data: c.raw });
  const sel = selector.finish();
  return { kept: sel.kept, decisions: sel.decisions, ms: performance.now() - t0 };
}

// ------------------------------------------------------------------ scoring

/** Fraction of ground-truth states holding at least one kept frame. */
function coverage(cands: Candidate[], kept: number[], states: number[], end: number): number {
  const times = kept.map((i) => cands[i].t);
  let hit = 0;
  for (let s = 0; s < states.length; s++) {
    const lo = states[s];
    const hi = s + 1 < states.length ? states[s + 1] : end;
    if (times.some((t) => t >= lo && t < hi)) hit++;
  }
  return hit / states.length;
}

function reportHtml(cands: Candidate[], decisions: FrameDecision[], slug: string): string {
  const rows = decisions
    .map((d) => {
      const c = cands[d.index];
      if (!c) return "";
      const cls = d.verdict === "drop" ? "drop" : d.verdict === "thinned" ? "thin" : "keep";
      const extra =
        d.settledScore !== undefined
          ? ` · settled ${d.settledScore.toFixed(1)}%/${d.settledGate!.toFixed(1)}%`
          : "";
      return (
        `<figure class="${cls}"><img src="cands/${c.jpg}" loading="lazy">` +
        `<figcaption>#${d.index} @${c.t.toFixed(1)}s · ${d.verdict} · dist ${d.globalDist.toFixed(1)}%${extra}</figcaption></figure>`
      );
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>${slug} — watch selection</title>
<style>body{font:14px system-ui;margin:20px;background:#111;color:#ddd}
.grid{display:flex;flex-wrap:wrap;gap:10px}figure{margin:0;width:200px}
img{width:100%;border-radius:4px}figcaption{font-size:11px;color:#999;padding:2px 0}
.drop img{opacity:.35;outline:2px solid #a33}.thin img{opacity:.35;outline:2px solid #a80}
.keep img{outline:2px solid #3a6}</style>
<h2>${slug}</h2><p>green kept · red duplicate · orange removed by the 36-frame cap</p>
<div class="grid">${rows}</div>`;
}

// --------------------------------------------------------------------- main

const fixtures = await buildFixtures();
const csv: string[] = ["video,method,candidates,kept,sheets,coverage,selectMs,extractMs"];
for (const f of fixtures) {
  const dir = path.join(OUT, f.slug);
  const { cands, ms: extractMs } = await extractCandidates(f.file, path.join(dir, "cands"));
  if (cands.length === 0) {
    console.log(`${f.slug}: no candidates — skipped`);
    continue;
  }
  const from = 0;
  const to = cands[cands.length - 1].t + 1;
  const a = methodA(cands, from, to);
  const c = methodC(cands);
  await writeFile(path.join(dir, "report.html"), reportHtml(cands, c.decisions, f.slug));

  console.log(`\n== ${f.slug} (${cands.length} candidates, ${to.toFixed(0)}s, extract ${(extractMs / 1000).toFixed(1)}s)`);
  for (const [name, kept, ms] of [
    ["A fixed", a, 0],
    ["C dedup", c.kept, c.ms],
  ] as const) {
    const cov = f.states ? coverage(cands, [...kept], f.states, to) : null;
    const sheets = Math.ceil(kept.length / 9);
    console.log(
      `  ${name}: kept ${String(kept.length).padStart(3)}  sheets ${sheets}` +
        (cov !== null ? `  state-coverage ${(cov * 100).toFixed(0)}%` : "") +
        (ms ? `  select ${ms.toFixed(0)}ms` : "")
    );
    csv.push(
      `${f.slug},${name.split(" ")[0]},${cands.length},${kept.length},${sheets},` +
        `${cov !== null ? cov.toFixed(3) : ""},${ms ? ms.toFixed(0) : ""},${extractMs.toFixed(0)}`
    );
  }
}
await writeFile(path.join(OUT, "stats.csv"), csv.join("\n") + "\n");
console.log(`\nstats: ${path.join(OUT, "stats.csv")}`);
console.log(`reports: ${OUT}/<slug>/report.html`);
