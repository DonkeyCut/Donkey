import { describe, expect, test } from "bun:test";
import {
  CHROMA_DEFAULT_INTENSITY,
  CHROMA_DEFAULT_SOFTNESS,
  CHROMA_DEFAULT_SPILL,
  CHROMA_NEAR_MAX,
  chromaAlphaInto,
  chromaAlphaOf,
  chromaParams,
  removalActive,
  removalFingerprint,
  removalNeedsBake,
  type ClipRemoval,
} from "./removal";

/** One RGBA pixel buffer of solid color. */
function frame(px: [number, number, number][], alpha = 255): Uint8ClampedArray {
  const data = new Uint8ClampedArray(px.length * 4);
  px.forEach(([r, g, b], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = alpha;
  });
  return data;
}

describe("chroma params", () => {
  test("defaults fill and the soft band sits past the tolerance", () => {
    const p = chromaParams({ color: "#00ff00" });
    expect(p.near).toBeCloseTo(CHROMA_DEFAULT_INTENSITY * CHROMA_NEAR_MAX, 5);
    expect(p.far).toBeGreaterThan(p.near);
    expect(p.spill).toBe(CHROMA_DEFAULT_SPILL);
    expect(Math.hypot(p.dirCb, p.dirCr)).toBeCloseTo(1, 5);
  });

  test("intensity widens the removed core and softness widens the band", () => {
    const tight = chromaParams({ color: "#00ff00", intensity: 0.2, softness: CHROMA_DEFAULT_SOFTNESS });
    const wide = chromaParams({ color: "#00ff00", intensity: 0.9, softness: CHROMA_DEFAULT_SOFTNESS });
    expect(wide.near).toBeGreaterThan(tight.near);
    const hard = chromaParams({ color: "#00ff00", softness: 0.05 });
    const soft = chromaParams({ color: "#00ff00", softness: 1 });
    expect(soft.far - soft.near).toBeGreaterThan(hard.far - hard.near);
  });

  test("alpha ramps monotonically from removed to kept", () => {
    const p = chromaParams({ color: "#00ff00" });
    expect(chromaAlphaOf(0, p)).toBe(0);
    expect(chromaAlphaOf(p.near, p)).toBe(0);
    expect(chromaAlphaOf(p.far, p)).toBe(1);
    expect(chromaAlphaOf(1, p)).toBe(1);
    const mid = chromaAlphaOf((p.near + p.far) / 2, p);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe("chroma keying", () => {
  test("the key color goes transparent and distant colors stay", () => {
    const px = frame([
      [0, 255, 0], // the key itself
      [255, 0, 0], // far from the key
      [255, 255, 255], // neutral
    ]);
    chromaAlphaInto(px, { color: "#00ff00" });
    expect(px[3]).toBe(0);
    expect(px[7]).toBe(255);
    expect(px[11]).toBe(255);
  });

  test("spill suppression pulls the key's tint off kept fringe", () => {
    // A green-fringed pixel just past the key's soft band keeps its alpha
    // while its green excess shrinks.
    const px = frame([[120, 230, 90]]);
    const before = px[1] - (px[0] + px[2]) / 2;
    chromaAlphaInto(px, { color: "#00ff00", intensity: 0.6, spill: 1 });
    const after = px[1] - (px[0] + px[2]) / 2;
    expect(px[3]).toBeGreaterThan(200);
    expect(after).toBeLessThan(before);
  });

  test("spill 0 leaves kept colors untouched", () => {
    const px = frame([[150, 205, 130]]);
    const want = [...px];
    chromaAlphaInto(px, { color: "#00ff00", intensity: 0.1, softness: 0.1, spill: 0 });
    expect(px[0]).toBe(want[0]);
    expect(px[1]).toBe(want[1]);
    expect(px[2]).toBe(want[2]);
  });
});

describe("removal model", () => {
  const seeds = { prompts: [{ t: 1, points: [{ x: 0.5, y: 0.5, label: 1 as const }] }] };

  test("fingerprint tracks the source and the selection", () => {
    expect(removalFingerprint("a", { mode: "auto" })).toBe(removalFingerprint("a", { mode: "auto" }));
    expect(removalFingerprint("a", { mode: "auto" })).not.toBe(
      removalFingerprint("b", { mode: "auto" })
    );
    expect(removalFingerprint("a", { mode: "auto" })).not.toBe(
      removalFingerprint("a", { mode: "custom", seeds })
    );
    expect(removalFingerprint("a", { mode: "custom", seeds })).not.toBe(
      removalFingerprint("a", { mode: "custom", seeds: { prompts: [] } })
    );
  });

  test("auto mode's fingerprint ignores the seeds and the subject", () => {
    expect(removalFingerprint("a", { mode: "auto", seeds })).toBe(
      removalFingerprint("a", { mode: "auto" })
    );
    expect(removalFingerprint("a", { mode: "auto", subject: "the dog" })).toBe(
      removalFingerprint("a", { mode: "auto" })
    );
  });

  test("custom mode's fingerprint tracks the described subject", () => {
    expect(removalFingerprint("a", { mode: "custom", subject: "the dog" })).not.toBe(
      removalFingerprint("a", { mode: "custom", subject: "the cat" })
    );
    expect(removalFingerprint("a", { mode: "custom", subject: "the dog" })).toBe(
      removalFingerprint("a", { mode: "custom", subject: "the dog" })
    );
  });

  test("active and needs-bake read the mode", () => {
    expect(removalActive(undefined)).toBe(false);
    expect(removalActive({ mode: "auto" })).toBe(true);
    expect(removalActive({ mode: "chroma" })).toBe(false);
    expect(removalActive({ mode: "chroma", chroma: { color: "#00ff00" } })).toBe(true);
    // A bake is owed only once it was explicitly started.
    expect(removalNeedsBake({ mode: "auto" })).toBe(false);
    expect(removalNeedsBake({ mode: "auto", requested: true })).toBe(true);
    const baked: ClipRemoval = {
      mode: "auto",
      requested: true,
      matte: { assetId: "m", fingerprint: "f", quality: "local", in: 0 },
    };
    expect(removalNeedsBake(baked)).toBe(false);
    expect(removalNeedsBake({ mode: "chroma" })).toBe(false);
  });
});
