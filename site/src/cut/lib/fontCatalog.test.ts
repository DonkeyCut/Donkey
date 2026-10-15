import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GOOGLE_FONTS } from "./fontCatalog";

// The catalog's weights are the faces googleFonts.ts declares for the page, so
// a font suggestion never offers a weight the page would draw synthesized.

const declared = readFileSync(new URL("./googleFonts.ts", import.meta.url), "utf8");
const faces = (style: "normal" | "italic") =>
  new Set(
    [...declared.matchAll(/@fontsource\/([a-z0-9-]+)\/(\d+)(-italic)?\.css/g)]
      .filter((m) => (style === "italic") === Boolean(m[3]))
      .map((m) => `${m[1]}/${m[2]}`)
  );
const pkg = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

test("every bundled family lists the weights the page declares", () => {
  const listed = new Set(GOOGLE_FONTS.flatMap((f) => f.weights.map((w) => `${pkg(f.label)}/${w}`)));
  expect(listed).toEqual(faces("normal"));
  const italics = new Set(GOOGLE_FONTS.flatMap((f) => (f.italics ?? []).map((w) => `${pkg(f.label)}/${w}`)));
  expect(italics).toEqual(faces("italic"));
});
