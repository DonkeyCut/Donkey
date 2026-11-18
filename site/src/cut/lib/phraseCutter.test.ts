import { describe, expect, test } from "bun:test";
import { PhraseCutter } from "./phraseCutter";

const RATE = 16000;

// Audio as the worklet delivers it: 250 ms chunks of 16 kHz s16 mono.
function tone(seconds: number, amplitude: number): Int16Array {
  const out = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(Math.sin((i * 2 * Math.PI * 220) / RATE) * amplitude * 0x7fff);
  }
  return out;
}
const quiet = (seconds: number) => tone(seconds, 0.001);
const voice = (seconds: number) => tone(seconds, 0.3);

function feed(cutter: PhraseCutter, ...parts: Int16Array[]): Int16Array[] {
  const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const out: Int16Array[] = [];
  for (let i = 0; i < all.length; i += RATE / 4) {
    out.push(...cutter.push(all.subarray(i, Math.min(all.length, i + RATE / 4))));
  }
  return out;
}

describe("PhraseCutter", () => {
  test("cuts a phrase at the pause after it", () => {
    const cutter = new PhraseCutter();
    const phrases = feed(cutter, quiet(1), voice(2), quiet(1));
    expect(phrases).toHaveLength(1);
    // The phrase carries the voice plus its pre-roll and the pause.
    expect(phrases[0].length / RATE).toBeGreaterThan(2);
    expect(phrases[0].length / RATE).toBeLessThan(3.2);
    expect(cutter.flush()).toBeNull();
  });

  test("sends nothing for a silent take", () => {
    const cutter = new PhraseCutter();
    expect(feed(cutter, quiet(20))).toHaveLength(0);
    expect(cutter.flush()).toBeNull();
  });

  test("cuts a long run without pauses at the cap", () => {
    const cutter = new PhraseCutter();
    const phrases = feed(cutter, voice(20));
    expect(phrases.length).toBeGreaterThanOrEqual(2);
    for (const p of phrases) {
      expect(p.length / RATE).toBeLessThanOrEqual(8);
    }
  });

  test("flush returns the open phrase", () => {
    const cutter = new PhraseCutter();
    expect(feed(cutter, voice(1))).toHaveLength(0);
    const last = cutter.flush();
    expect(last).not.toBeNull();
    expect(last!.length / RATE).toBeGreaterThan(0.9);
  });

  test("keeps every phrase of a take in order", () => {
    const cutter = new PhraseCutter();
    const phrases = feed(cutter, voice(2), quiet(0.8), voice(2), quiet(0.8), voice(2));
    const last = cutter.flush();
    expect(phrases).toHaveLength(2);
    expect(last).not.toBeNull();
  });
});
