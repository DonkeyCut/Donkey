import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The page declares every bundled face as an unloaded FontFace, one per
// unicode subset, so a family costs the bundle nothing until text in it draws.

interface AddedFace {
  family: string;
  source: string;
  descriptors: FontFaceDescriptors;
  loaded: boolean;
}

const added: AddedFace[] = [];
const saved = { FontFace: globalThis.FontFace, document: globalThis.document };

/** A FontFace that records its arguments and whether anyone loaded it. */
class RecordingFace {
  face: AddedFace;
  constructor(family: string, source: string, descriptors: FontFaceDescriptors) {
    this.face = { family, source, descriptors, loaded: false };
  }
  load() {
    this.face.loaded = true;
    return Promise.resolve(this);
  }
}

beforeAll(async () => {
  Object.assign(globalThis, {
    FontFace: RecordingFace,
    document: { fonts: { add: (f: RecordingFace) => added.push(f.face) } },
  });
  await import("./googleFonts");
});
afterAll(() => {
  Object.assign(globalThis, saved);
});

/** Each subset's unicode-range in a @fontsource stylesheet, by file. */
function rangesIn(css: string): Map<string, string> {
  const ranges = new Map<string, string>();
  for (const [, body] of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const file = body.match(/url\(\.\/files\/([^)]+\.woff2)\)/)![1];
    ranges.set(file, body.match(/unicode-range:\s*([^;]+);/)![1].trim());
  }
  return ranges;
}

test("a listed family gets a lazy FontFace per subset with its unicode range", () => {
  const css = readFileSync(new URL("../../../node_modules/@fontsource/inter/400.css", import.meta.url), "utf8");
  const expected = rangesIn(css);
  const inter400 = added.filter((f) => f.family === "Inter" && f.descriptors.weight === "400");

  expect(expected.size).toBeGreaterThan(1);
  expect(inter400.length).toBe(expected.size);
  for (const [file, range] of expected) {
    const face = inter400.find((f) => f.source.includes(`/cut-fonts/${file}`));
    expect(face?.descriptors).toMatchObject({ style: "normal", unicodeRange: range });
  }
  expect(added.some((f) => f.loaded)).toBe(false);
});

test("the stand-in families stay off the page", () => {
  expect(added.some((f) => f.family === "Roboto")).toBe(false);
});
