import { describe, expect, test } from "bun:test";
import {
  autoGradeFromImageData,
  gradeTint,
  gradeToCssFilter,
  gradeToFfmpegFilter,
  isNeutralGrade,
  normalizeGrade,
} from "./colorGrade";

/** RGBA frame from repeating [r,g,b] pixel patterns. */
function frame(...pixels: [number, number, number][]): Uint8ClampedArray {
  const per = 64;
  const data = new Uint8ClampedArray(pixels.length * per * 4);
  pixels.forEach(([r, g, b], p) => {
    for (let i = 0; i < per; i++) {
      const o = (p * per + i) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  });
  return data;
}

describe("neutrality", () => {
  test("absent, empty, and all-zero grades are neutral", () => {
    expect(isNeutralGrade(undefined)).toBe(true);
    expect(isNeutralGrade({})).toBe(true);
    expect(isNeutralGrade({ brightness: 0, hue: 0 })).toBe(true);
    expect(isNeutralGrade({ saturation: -5 })).toBe(false);
  });

  test("normalize strips zeros and collapses to undefined", () => {
    expect(normalizeGrade({ brightness: 0, contrast: 0 })).toBeUndefined();
    expect(normalizeGrade({ brightness: 10, contrast: 0 })).toEqual({ brightness: 10 });
  });

  test("normalize clamps out-of-range and drops garbage input", () => {
    expect(normalizeGrade({ brightness: 999, hue: -999 })).toEqual({ brightness: 50, hue: -180 });
    expect(normalizeGrade({ contrast: Number.NaN, saturation: Infinity })).toBeUndefined();
  });

  test("neutral grades emit nothing", () => {
    expect(gradeToCssFilter(undefined)).toBe("");
    expect(gradeToFfmpegFilter({ brightness: 0 })).toBe("");
    expect(gradeTint({})).toBe(null);
  });
});

describe("css filter", () => {
  test("brightness and exposure fold into one gain", () => {
    // (1 + 20/100) · 2^(50/50) = 2.4
    expect(gradeToCssFilter({ brightness: 20, exposure: 50 })).toBe("brightness(2.400)");
  });

  test("emits only non-neutral terms, in application order", () => {
    expect(gradeToCssFilter({ contrast: 25, hue: -90 })).toBe("contrast(1.250) hue-rotate(-90.000deg)");
    expect(gradeToCssFilter({ saturation: -50 })).toBe("saturate(0.000)");
  });

  test("warmth keeps luminance: gain rises, tint dims the cool channel", () => {
    // t=1 → gains (1.25, 1, 0.75), normalized by 1.25.
    expect(gradeToCssFilter({ temperature: 50 })).toBe("brightness(1.250)");
    expect(gradeTint({ temperature: 50 })).toBe("rgb(255, 204, 153)");
    expect(gradeTint({ temperature: -50 })).toBe("rgb(153, 204, 255)");
  });
});

describe("auto grade", () => {
  test("a mid-gray frame needs nearly nothing", () => {
    const g = autoGradeFromImageData(frame([118, 118, 118]));
    expect(Math.abs(g?.exposure ?? 0) <= 1).toBe(true);
    expect(g?.contrast).toBeUndefined(); // flat histogram = no tonal signal
    expect(g?.temperature).toBeUndefined();
  });

  test("a dark frame gets pushed up toward middle gray", () => {
    const g = autoGradeFromImageData(frame([30, 30, 30], [50, 50, 50]));
    expect((g?.exposure ?? 0) > 10).toBe(true);
  });

  test("a compressed tonal range gets a contrast stretch", () => {
    const g = autoGradeFromImageData(frame([100, 100, 100], [150, 150, 150]));
    expect((g?.contrast ?? 0) > 0).toBe(true);
  });

  test("gray-world counters color casts both ways, hue and saturation stay", () => {
    const cool = autoGradeFromImageData(frame([90, 120, 170]));
    expect((cool?.temperature ?? 0) > 0).toBe(true);
    const warm = autoGradeFromImageData(frame([170, 120, 90]));
    expect((warm?.temperature ?? 0) < 0).toBe(true);
    expect(cool?.saturation).toBeUndefined();
    expect(cool?.hue).toBeUndefined();
  });

  test("an empty sample yields no grade", () => {
    expect(autoGradeFromImageData(new Uint8ClampedArray(0))).toBeUndefined();
  });
});

describe("ffmpeg filter", () => {
  test("gain+contrast ride one lutrgb, trailing comma included", () => {
    const expr = "clip((clip(val*1.100,0,255)-128)*1.200+128,0,255)";
    expect(gradeToFfmpegFilter({ brightness: 10, contrast: 20 })).toBe(
      `lutrgb=r='${expr}':g='${expr}':b='${expr}',`,
    );
  });

  test("saturation and hue share the hue filter", () => {
    expect(gradeToFfmpegFilter({ saturation: 25, hue: 45 })).toBe("hue=h=45.000:s=1.500,");
  });

  test("temperature emits the gain lut and the tint lut in preview order", () => {
    expect(gradeToFfmpegFilter({ temperature: 50 })).toBe(
      "lutrgb=r='clip((clip(val*1.250,0,255)-128)*1.000+128,0,255)'" +
        ":g='clip((clip(val*1.250,0,255)-128)*1.000+128,0,255)'" +
        ":b='clip((clip(val*1.250,0,255)-128)*1.000+128,0,255)'," +
        "lutrgb=r='clip(val*1.000,0,255)':g='clip(val*0.800,0,255)':b='clip(val*0.600,0,255)',",
    );
  });
});
