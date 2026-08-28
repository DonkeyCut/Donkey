import { describe, expect, test } from "bun:test";
import { removalActive, removalFingerprint, removalNeedsBake, type ClipRemoval } from "./removal";

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
    // Off keeps the removal on the clip but renders and bakes nothing.
    expect(removalActive({ mode: "auto", off: true })).toBe(false);
    expect(removalNeedsBake({ mode: "auto", off: true })).toBe(false);
    // A bake is owed only once Apply (or the chat tool) requests it.
    expect(removalNeedsBake({ mode: "auto" })).toBe(false);
    expect(removalNeedsBake({ mode: "auto", requested: true })).toBe(true);
    expect(removalNeedsBake({ mode: "custom" })).toBe(false);
    expect(removalNeedsBake({ mode: "custom", requested: true })).toBe(true);
    const baked: ClipRemoval = {
      mode: "auto",
      matte: { assetId: "m", fingerprint: "f", quality: "local", in: 0 },
    };
    expect(removalNeedsBake(baked)).toBe(false);
  });
});
