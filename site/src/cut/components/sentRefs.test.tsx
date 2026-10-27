import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssetRef } from "@/cut/lib/assetRef";
import { WithIntl } from "@/i18n/testing";
import { refHasCard, UnmentionedRefPills } from "./AssetRefs";

const note: AssetRef = { scope: "note", id: "n1", name: "Shot list", kind: "text", url: "data:text/plain," };
const video: AssetRef = { scope: "project", id: "a1", name: "beach", kind: "video", url: "/m/beach.mp4" };

// A sent card earns its place by doing something on click.
describe("sent refs", () => {
  test("media gets a card and a note does not", () => {
    expect(refHasCard(video)).toBe(true);
    expect(refHasCard(note)).toBe(false);
  });

  test("an unmentioned note reads as its pill", () => {
    const html = renderToStaticMarkup(<WithIntl><UnmentionedRefPills text="tighten this" refs={[note, video]} /></WithIntl>);
    expect(html).toContain("Shot list");
    expect(html).toContain("target=\"_blank\"");
    expect(html).not.toContain("beach");
  });

  test("a note named in the text draws no second pill", () => {
    const html = renderToStaticMarkup(<WithIntl><UnmentionedRefPills text={`use @"Shot list"`} refs={[note]} /></WithIntl>);
    expect(html).toBe("");
  });
});
