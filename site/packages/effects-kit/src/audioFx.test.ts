import { describe, expect, test } from "bun:test";
import {
  AUDIO_EFFECT_IDS,
  AUDIO_EFFECT_LABELS,
  audioFxBars,
  audioFxFilters,
  audioFxRecipe,
  normalizeSound,
  SOUND_EQ_BANDS,
  SOUND_PRESETS,
  soundFilters,
  soundRecipe,
} from "./audioFx";
import { ALL_EFFECT_IDS, EFFECT_IDS, EFFECT_LABELS } from "./effects";

// The bundled engine ffmpeg is LGPL and carries no GPL-only filters. A recipe
// reaching past this list renders on a dev machine (Homebrew ffmpeg, a GPL
// build) and fails in the shipped app.
const LGPL_AUDIO_FILTERS = new Set([
  "aecho",
  "lowpass",
  "highpass",
  "lowshelf",
  "highshelf",
  "equalizer",
  "tremolo",
  "acrusher",
  "acompressor",
  "alimiter",
  "volume",
]);

const filterNamesOf = (chain: string) =>
  chain.split(",").map((step) => step.split("=")[0].trim());

describe("audio effect recipes", () => {
  test("every id has a recipe, a label and a place in the effect list", () => {
    for (const id of AUDIO_EFFECT_IDS) {
      expect(audioFxRecipe(id, 0.5)).not.toBeNull();
      expect(AUDIO_EFFECT_LABELS[id]).toBeTruthy();
      expect(EFFECT_LABELS[id]).toBe(AUDIO_EFFECT_LABELS[id]);
      expect(ALL_EFFECT_IDS).toContain(id);
      // The picture list stays the picture's: the stage walks it per frame.
      expect(EFFECT_IDS as string[]).not.toContain(id);
    }
  });

  test("an unknown id has neither a recipe nor a chain", () => {
    expect(audioFxRecipe("nope", 0.5)).toBeNull();
    expect(audioFxFilters("nope", 0.5)).toBeNull();
    // A picture effect is not an audio one either — the mix leaves it alone.
    expect(audioFxFilters("grain", 0.5)).toBeNull();
  });

  test("every chain is built from filters the shipped ffmpeg has", () => {
    for (const id of AUDIO_EFFECT_IDS) {
      for (const amount of [0.05, 0.5, 1]) {
        const chain = audioFxFilters(id, amount);
        expect(chain).toBeTruthy();
        for (const name of filterNamesOf(chain!)) {
          expect(LGPL_AUDIO_FILTERS.has(name)).toBe(true);
        }
      }
    }
  });

  test("aecho's gains stay inside the range the filter takes", () => {
    for (const id of AUDIO_EFFECT_IDS) {
      const recipe = audioFxRecipe(id, 1)!;
      expect(recipe.dry).toBeGreaterThan(0);
      expect(recipe.dry).toBeLessThanOrEqual(1);
      for (const tap of recipe.taps) {
        expect(tap.gain).toBeGreaterThan(0);
        expect(tap.gain).toBeLessThan(1);
        expect(tap.ms).toBeGreaterThan(0);
      }
    }
  });

  test("the delay effects spell their taps as one aecho", () => {
    const echo = audioFxFilters("echo", 1)!;
    expect(echo.startsWith("aecho=")).toBe(true);
    // Three repeats, spelled as three delays and three decays.
    const [, , delays, decays] = echo.split(",")[0].split(":");
    expect(delays.split("|")).toHaveLength(3);
    expect(decays.split("|")).toHaveLength(3);
  });

  test("strength moves what the effect is made of", () => {
    const quiet = audioFxRecipe("echo", 0.1)!;
    const loud = audioFxRecipe("echo", 1)!;
    expect(loud.taps[0].gain).toBeGreaterThan(quiet.taps[0].gain);
    // A muffle closes further down as it goes up.
    expect(audioFxRecipe("muffle", 1)!.bands[0].hz).toBeLessThan(
      audioFxRecipe("muffle", 0.1)!.bands[0].hz
    );
    // Out-of-range amounts clamp rather than invert the recipe.
    expect(audioFxRecipe("echo", 5)!.taps[0].gain).toBe(loud.taps[0].gain);
    expect(audioFxRecipe("echo", -1)!.taps[0].gain).toBeGreaterThan(0);
  });
});

describe("clip sound", () => {
  test("a neutral treatment stores as absence", () => {
    expect(normalizeSound(undefined)).toBeUndefined();
    expect(normalizeSound({})).toBeUndefined();
    expect(normalizeSound({ eq: [0, 0, 0, 0, 0, 0, 0] })).toBeUndefined();
    expect(
      normalizeSound({ compressor: { threshold: -18, ratio: 1, attack: 10, release: 80 } })
    ).toBeUndefined();
    expect(normalizeSound({ limiter: { ceiling: 0 } })).toBeUndefined();
    expect(soundRecipe({})).toBeNull();
    expect(soundFilters(undefined)).toBeNull();
  });

  test("the equalizer keeps one value per band and clamps it", () => {
    const s = normalizeSound({ eq: [40, -40, 1] })!;
    expect(s.eq).toHaveLength(SOUND_EQ_BANDS.length);
    expect(s.eq![0]).toBe(12);
    expect(s.eq![1]).toBe(-12);
    expect(s.eq![2]).toBe(1);
    expect(s.eq![6]).toBe(0);
    // A flat band builds no section.
    expect(soundRecipe(s)!.bands).toHaveLength(3);
  });

  test("every preset spells a chain from filters the shipped ffmpeg has", () => {
    for (const p of SOUND_PRESETS) {
      const chain = soundFilters(p.sound);
      if (!p.sound) {
        expect(chain).toBeNull();
        continue;
      }
      expect(chain).toBeTruthy();
      for (const name of filterNamesOf(chain!)) {
        expect(LGPL_AUDIO_FILTERS.has(name)).toBe(true);
      }
    }
  });

  test("the voice preset runs a shelf, peaks, a shelf, then level control", () => {
    const chain = soundFilters(SOUND_PRESETS.find((p) => p.id === "clear-voice")!.sound)!;
    const names = filterNamesOf(chain);
    expect(names[0]).toBe("lowshelf");
    // The shelves carry the slope Web Audio's shelf nodes run at.
    expect(chain).toContain("lowshelf=f=100:width_type=s:w=1:g=2");
    expect(names[names.length - 3]).toBe("highshelf");
    expect(names[names.length - 2]).toBe("acompressor");
    expect(names[names.length - 1]).toBe("alimiter");
    // Thresholds go to ffmpeg as linear amplitude.
    expect(chain).toContain("acompressor=threshold=0.126:ratio=3:attack=10:release=80");
    expect(chain).toContain("alimiter=limit=0.891");
  });
});

describe("audio effect tile figures", () => {
  test("bars stay inside the tile whatever the effect and moment", () => {
    for (const id of [...AUDIO_EFFECT_IDS, null]) {
      for (const t of [0, 0.12, 0.7, 1.4, 9]) {
        const bars = audioFxBars(id, t, 24, 0.9);
        expect(bars).toHaveLength(24);
        for (const v of bars) {
          expect(v).toBeGreaterThanOrEqual(0.1);
          expect(v).toBeLessThanOrEqual(1);
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });

  test("each effect shapes the untreated figure into its own", () => {
    const plain = audioFxBars(null, 0.4, 24, 0.9);
    const seen = new Set<string>();
    for (const id of AUDIO_EFFECT_IDS) {
      const bars = audioFxBars(id, 0.4, 24, 0.9);
      const key = bars.map((v) => v.toFixed(3)).join(",");
      expect(key).not.toBe(plain.map((v) => v.toFixed(3)).join(","));
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test("the figure rolls with the clock", () => {
    const a = audioFxBars("echo", 0, 24, 0.9);
    const b = audioFxBars("echo", 0.5, 24, 0.9);
    expect(a.join()).not.toBe(b.join());
  });
});
