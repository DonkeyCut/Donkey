import { expect, test } from "bun:test";
import manifest from "../../../public/cut-fonts/manifest.json";
import { GOOGLE_FONTS } from "./fontCatalog";

// The catalog's weights are the faces staged for the page, so a font
// suggestion never offers a weight the page would draw synthesized.

const faces = (style: "normal" | "italic") =>
  new Set(
    manifest.flatMap((entry) =>
      entry.id ? entry.faces.filter((f) => f.style === style).map((f) => `${entry.id}/${f.weight}`) : []
    )
  );

test("every bundled family lists the weights the page declares", () => {
  const listed = new Set(GOOGLE_FONTS.flatMap((f) => f.weights.map((w) => `${f.id}/${w}`)));
  expect(listed).toEqual(faces("normal"));
  const italics = new Set(GOOGLE_FONTS.flatMap((f) => (f.italics ?? []).map((w) => `${f.id}/${w}`)));
  expect(italics).toEqual(faces("italic"));
});
