// Fits the shipped grade presets to the color-science spec
// (packages/effects-kit/src/gradeSpec.ts): each recipe's own numbers, plus
// orange and red hue bands that hold skin, move by coordinate descent until
// every bound the spec sets — identity, skin, saturation, levels, range on
// every source — is met with a small margin, staying as close to the
// original recipe as the bounds allow. Only presets that miss a bound move.
//
//   cd site && ./node_modules/.bin/bun scripts/tune-grade-presets.ts [preset ids…] [--write]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type ColorGrade,
  GRADE_SCALAR_FIELDS,
  createGradeTransform,
  normalizeGrade,
} from "../packages/effects-kit/src/index";
import { GRADE_PRESETS, type GradePreset } from "../packages/effects-kit/src/gradePresets";
import {
  type Expect,
  IDENTITY,
  LOOK_LOSS_MAX,
  PREMISE,
  isMonotone,
  levelsHold,
  measure,
  monochrome,
  rangeRamp,
  saturationBounded,
  skinStaysSkin,
  stopsLost,
} from "../packages/effects-kit/src/gradeSpec";
import type { OutputSpace, SourceProfile } from "../packages/effects-kit/src/colorSpace";

const PRESET_DIR = path.join(import.meta.dir, "../packages/effects-kit/src/presets");
const FILES = ["cinematic", "film", "warm", "mood", "bw"];

/** The sources and outputs a look has to keep its range on. */
const RANGE_CASES: [SourceProfile, OutputSpace][] = [
  ["rec709", "sdr"],
  ["apple-log", "sdr"],
  ["apple-log-2", "sdr"],
  ["hlg", "sdr"],
  ["apple-log-2", "hlg"],
];

/** How far inside each bound the fit aims, so LUT quantization cannot tip a
 * fitted value back over: a few percent of the bound. */
const margin = (n: number) => Math.max(Math.abs(n) * 0.03, 0.01);

/** An expect that records how far each bound is missed and keeps going. */
function recorder(): { expect: Expect; total: () => number } {
  let miss = 0;
  const expect: Expect = (v) => ({
    toBe: (want) => {
      if (v !== want) miss += 1;
    },
    toBeLessThan: (n) => (miss += Math.max(0, (v as number) - (n - margin(n))) / Math.max(1, Math.abs(n))),
    toBeLessThanOrEqual: (n) => (miss += Math.max(0, (v as number) - (n - margin(n))) / Math.max(1, Math.abs(n))),
    toBeGreaterThan: (n) => (miss += Math.max(0, n + margin(n) - (v as number)) / Math.max(1, Math.abs(n))),
    toBeGreaterThanOrEqual: (n) => (miss += Math.max(0, n + margin(n) - (v as number)) / Math.max(1, Math.abs(n))),
  });
  return { expect, total: () => miss };
}

/** Every bound the spec sets for a preset, summed as misses. */
function misses(p: GradePreset, grade: ColorGrade): number {
  const t = createGradeTransform(grade);
  if (!t) return 1e6;
  const m = measure((colors) =>
    colors.map((c) => t(c[0] / 255, c[1] / 255, c[2] / 255).map((v) => Math.max(0, Math.min(255, Math.round(v * 255)))))
  );
  const { expect, total } = recorder();
  IDENTITY[p.id]?.holds(m, expect);
  PREMISE[p.category]?.(m, expect);
  levelsHold(m, expect);
  if (p.category === "bw") monochrome(m, expect);
  else {
    skinStaysSkin(m, expect);
    saturationBounded(m, expect);
  }
  let range = 0;
  for (const [profile, output] of RANGE_CASES) {
    const base = rangeRamp(profile, output);
    const graded = rangeRamp(profile, output, grade);
    range += Math.max(0, stopsLost(base, graded) - (LOOK_LOSS_MAX - 0.1));
    if (!isMonotone(graded)) range += 1;
  }
  return total() + range;
}

/** A tunable number inside a grade, by path. */
type Knob = { path: (string | number)[]; min: number; max: number };

const SCALAR_RANGE = new Map(GRADE_SCALAR_FIELDS.map(([k, min, max]) => [k, [min, max] as const]));

function knobsOf(g: ColorGrade): Knob[] {
  const knobs: Knob[] = [];
  for (const [k, v] of Object.entries(g)) {
    if (typeof v === "number") {
      const [min, max] = SCALAR_RANGE.get(k) ?? [-50, 50];
      knobs.push({ path: [k], min, max });
    }
  }
  for (const zone of Object.keys(g.wheels ?? {})) for (let i = 0; i < 3; i++) knobs.push({ path: ["wheels", zone, i], min: -50, max: 50 });
  for (const band of new Set([...Object.keys(g.hsl ?? {}), "orange", "red"]))
    for (let i = 0; i < 2; i++) knobs.push({ path: ["hsl", band, i], min: -50, max: 50 });
  for (const [ch, pts] of Object.entries(g.curves ?? {}))
    for (let i = 0; i < (pts as unknown[]).length; i++) knobs.push({ path: ["curves", ch, i, 1], min: 0, max: 255 });
  return knobs;
}

function read(g: ColorGrade, p: (string | number)[]): number {
  let o: unknown = g;
  for (const k of p) o = (o as Record<string | number, unknown> | undefined)?.[k];
  return typeof o === "number" ? o : 0;
}

function write(g: ColorGrade, p: (string | number)[], v: number): ColorGrade {
  const out = structuredClone(g) as Record<string, unknown>;
  let o: Record<string | number, unknown> = out;
  for (let i = 0; i < p.length - 1; i++) {
    if (o[p[i]] === undefined) o[p[i]] = p[i] === "hsl" ? {} : [0, 0, 0];
    o = o[p[i]] as Record<string | number, unknown>;
  }
  o[p[p.length - 1]] = v;
  return out as ColorGrade;
}

/** A curve keeps its points rising: a point moves only between its neighbors. */
function curveOk(g: ColorGrade, p: (string | number)[]): boolean {
  if (p[0] !== "curves") return true;
  const pts = g.curves?.[p[1] as "m"] ?? [];
  return pts.every((pt, i) => i === 0 || pt[1] >= pts[i - 1][1]);
}

/** Squared distance from the original recipe, each knob over its span. */
function drift(g: ColorGrade, from: ColorGrade, knobs: Knob[]): number {
  return knobs.reduce((a, k) => a + ((read(g, k.path) - read(from, k.path)) / (k.max - k.min)) ** 2, 0);
}

const DRIFT_WEIGHT = 0.5;
const STEPS = [8, 4, 2, 1];

function fit(p: GradePreset): { grade: ColorGrade; before: number; after: number } {
  const from = p.grade;
  const knobs = knobsOf(from);
  const cost = (g: ColorGrade) => misses(p, g) * 100 + DRIFT_WEIGHT * drift(g, from, knobs);
  let best = from;
  let bestCost = cost(from);
  const before = misses(p, from);
  // Steepest coordinate descent: each round takes the single knob move that
  // helps most, so the recipe changes only where the bounds need it.
  for (const step of STEPS) {
    for (;;) {
      let move: ColorGrade | null = null;
      let moveCost = bestCost;
      for (const k of knobs) {
        for (const dir of [-1, 1]) {
          const v = Math.max(k.min, Math.min(k.max, read(best, k.path) + dir * step));
          const g = write(best, k.path, v);
          if (!curveOk(g, k.path)) continue;
          const c = cost(g);
          if (c < moveCost - 1e-9) {
            move = g;
            moveCost = c;
          }
        }
      }
      if (!move) break;
      best = move;
      bestCost = moveCost;
    }
  }
  return { grade: normalizeGrade(best) ?? from, before, after: misses(p, best) };
}

/* ------------------------------------------------------------------ */
/* Writing the catalog back in its own layout                          */
/* ------------------------------------------------------------------ */

const inline = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(inline).join(", ")}]`
    : v && typeof v === "object"
      ? `{ ${Object.entries(v).map(([k, x]) => `"${k}": ${inline(x)}`).join(", ")} }`
      : JSON.stringify(v);

function gradeText(g: ColorGrade): string {
  const lines = Object.entries(g).map(([k, v]) => {
    if (k === "curves" && Object.keys(v as object).length > 1) {
      const chans = Object.entries(v as object).map(([c, pts]) => `        "${c}": ${inline(pts)}`);
      return `      "curves": {\n${chans.join(",\n")}\n      }`;
    }
    return `      "${k}": ${inline(v)}`;
  });
  return `{\n${lines.join(",\n")}\n    }`;
}

function writeCatalog(file: string, presets: GradePreset[]): void {
  const entries = presets.map(
    (p) =>
      `  {\n    "id": ${JSON.stringify(p.id)},\n    "label": ${JSON.stringify(p.label)},\n    "category": ${JSON.stringify(p.category)},\n    "look": ${JSON.stringify(p.look)},\n    "grade": ${gradeText(p.grade)}\n  }`
  );
  writeFileSync(path.join(PRESET_DIR, `${file}.json`), `[\n${entries.join(",\n")}\n]\n`);
}

const args = process.argv.slice(2);
const shouldWrite = args.includes("--write");
const wanted = new Set(args.filter((a) => !a.startsWith("--")));
const tuned = new Map<string, ColorGrade>();
for (const p of Object.values(GRADE_PRESETS)) {
  if (wanted.size && !wanted.has(p.id)) continue;
  if (!wanted.size && misses(p, p.grade) === 0) continue;
  const { grade, before, after } = fit(p);
  tuned.set(p.id, grade);
  console.log(`${p.id.padEnd(14)} misses ${before.toFixed(3)} → ${after.toFixed(3)}  ${JSON.stringify(grade)}`);
}
if (shouldWrite) {
  for (const file of FILES) {
    const raw = JSON.parse(readFileSync(path.join(PRESET_DIR, `${file}.json`), "utf8")) as GradePreset[];
    writeCatalog(
      file,
      raw.map((p) => (tuned.has(p.id) ? { ...p, grade: tuned.get(p.id)! } : p))
    );
  }
  console.log(`wrote ${tuned.size} presets`);
}
