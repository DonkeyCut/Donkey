import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ColorGrade } from "./colorGrade";
import type { OutputSpace, SourceProfile } from "./colorSpace";
import { GRADE_PRESET_IDS } from "./gradePresets";
import { LOOK_LOSS_MAX, isMonotone, rangeRamp, stopsLost } from "./gradeSpec";
import { parseCube } from "./lutFile";

const CASES: [SourceProfile, OutputSpace][] = [
  ["rec709", "sdr"],
  ["apple-log", "sdr"],
  ["apple-log-2", "sdr"],
  ["hlg", "sdr"],
  ["apple-log-2", "hlg"],
];

describe("presets keep the picture's range", () => {
  for (const [profile, output] of CASES) {
    const base = rangeRamp(profile, output);
    for (const id of GRADE_PRESET_IDS) {
      test(`${id} on ${profile} → ${output}`, () => {
        const graded = rangeRamp(profile, output, { preset: { id } });
        expect(isMonotone(graded)).toBe(true);
        expect(stopsLost(base, graded)).toBeLessThanOrEqual(LOOK_LOSS_MAX);
      });
    }
  }
});

describe("single controls never fold or hard-clip the ramp", () => {
  const SLIDERS: (keyof ColorGrade)[] = [
    "exposure",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "brilliance",
    "fade",
    "temperature",
    "tint",
    "saturation",
    "vibrance",
  ];
  const WHEEL_SETTINGS: ColorGrade[] = (["s", "m", "h", "o"] as const).flatMap((z) => [
    { wheels: { [z]: [0, 0, -25] } },
    { wheels: { [z]: [0, 0, 25] } },
  ]);
  /** A control at half travel may spend this many stops of the window. */
  const CONTROL_LOSS_MAX = 1;
  for (const [profile, output] of CASES.slice(0, 3)) {
    const base = rangeRamp(profile, output);
    const grades: [string, ColorGrade][] = [
      ...SLIDERS.flatMap((k) =>
        [-25, 25].filter((v) => v > 0 || k !== "fade").map((v) => [`${k} ${v}`, { [k]: v } as ColorGrade] as [string, ColorGrade])
      ),
      ...WHEEL_SETTINGS.map((g) => [JSON.stringify(g.wheels), g] as [string, ColorGrade]),
    ];
    for (const [name, grade] of grades) {
      test(`${name} on ${profile}`, () => {
        const graded = rangeRamp(profile, output, grade);
        expect(isMonotone(graded)).toBe(true);
        expect(stopsLost(base, graded)).toBeLessThanOrEqual(CONTROL_LOSS_MAX);
      });
    }
  }
});

describe("built-in LUTs keep the picture's range", () => {
  // Every .cube the site ships is a built-in look.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../public/cut/luts");
  const files = readdirSync(dir).filter((f) => f.endsWith(".cube"));
  for (const [profile, output] of CASES.slice(0, 3)) {
    const base = rangeRamp(profile, output);
    for (const file of files) {
      test(`${file} on ${profile}`, () => {
        const lut = parseCube(readFileSync(path.join(dir, file), "utf8"));
        const graded = rangeRamp(profile, output, { lut: { id: `lut:${file}` } }, lut);
        expect(isMonotone(graded)).toBe(true);
        expect(stopsLost(base, graded)).toBeLessThanOrEqual(LOOK_LOSS_MAX);
      });
    }
  }
});
