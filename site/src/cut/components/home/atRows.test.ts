import { describe, expect, test } from "bun:test";
import { filterAtRows, isStartTemplateRef, libraryTab, RECENT_ROWS, rowKind, startTemplateRef, tabsWithRows, uniqueNames, type AtRow } from "./atRows";
import { projectTileSize } from "./projectTile";
import type { GalleryTemplate } from "@/cut/lib/templateGallery";

const row = (name: string, tab: AtRow["tab"], at: number): AtRow => ({
  ref: { scope: "library", id: name, name, kind: "video", url: `https://x/${name}` },
  label: name,
  tab,
  at,
  preview: { kind: "icon", icon: "file" },
});

const rows = [row("beach", "clips", 3), row("Beach song", "audio", 5), row("sunset beach", "images", 1), row("intro", "templates", 0)];

describe("@ picker rows", () => {
  test("nothing typed lists recent rows, newest first", () => {
    expect(filterAtRows(rows, "all", "").map((r) => r.ref.name)).toEqual(["Beach song", "beach", "sunset beach"]);
  });

  test("a tab with no clock lists its rows in order", () => {
    expect(filterAtRows(rows, "templates", "").map((r) => r.ref.name)).toEqual(["intro"]);
  });

  test("recents stop at the recent count", () => {
    const many = Array.from({ length: RECENT_ROWS + 4 }, (_, i) => row(`c${i}`, "clips", i + 1));
    expect(filterAtRows(many, "clips", "")).toHaveLength(RECENT_ROWS);
  });

  test("typed text keeps prefix matches ahead of matches inside the name", () => {
    expect(filterAtRows(rows, "all", "bea").map((r) => r.ref.name)).toEqual(["beach", "Beach song", "sunset beach"]);
    expect(filterAtRows(rows, "images", "bea").map((r) => r.ref.name)).toEqual(["sunset beach"]);
    expect(filterAtRows(rows, "all", "zzz")).toEqual([]);
  });

  test("only types that hold something get a tab", () => {
    expect(tabsWithRows(rows)).toEqual(["all", "clips", "images", "audio", "templates"]);
    expect(tabsWithRows([])).toEqual(["all"]);
  });

  test("each row says what it is, so a project and a clip of one name read apart", () => {
    expect(rowKind(row("Untitled", "projects", 1))).toBe("project");
    expect(rowKind(row("Untitled", "clips", 1))).toBe("video");
    const lut = { ...row("film look", null, 9), preview: { kind: "file", asset: { type: "lut" } } } as AtRow;
    expect(rowKind(lut)).toBe("lut");
  });

  test("a row with no tab lists under All only", () => {
    const lut = row("film look", null, 9);
    expect(filterAtRows([lut], "all", "")).toHaveLength(1);
    expect(filterAtRows([lut], "clips", "")).toHaveLength(0);
  });

  test("a repeated name carries its id so each pick resolves to its row", () => {
    const named = uniqueNames([row("beach", "clips", 1), { ...row("Beach", "images", 2), ref: { ...row("Beach", "images", 2).ref, id: "i2" } }]);
    expect(named.map((r) => r.ref.name)).toEqual(["beach", "Beach [i2]"]);
  });

  test("library kinds map to their tabs", () => {
    expect(libraryTab("video")).toBe("clips");
    expect(libraryTab("image")).toBe("images");
    expect(libraryTab("audio")).toBe("audio");
    expect(libraryTab("lut")).toBeNull();
  });

  test("a starting template pills as a template and is recognised on send", () => {
    const template = { id: "surf" } as GalleryTemplate;
    const ref = startTemplateRef({ kind: "gallery", template }, "Surf");
    expect(ref.name).toBe("Surf template");
    expect(ref.entityKind).toBe("template");
    expect(isStartTemplateRef(ref)).toBe(true);
    expect(isStartTemplateRef({ id: "catalog:template:x" })).toBe(false);
  });
});

describe("project tiles", () => {
  test("every card covers the same area, so a square is smaller than a wide card is wide", () => {
    expect(projectTileSize("9:16")).toEqual({ width: 158, height: 280 });
    expect(projectTileSize("16:9")).toEqual({ width: 280, height: 158 });
    expect(projectTileSize("1:1")).toEqual({ width: 210, height: 210 });
    expect(projectTileSize("4:5")).toEqual({ width: 188, height: 235 });
  });

  test("a card past 16:9 stops at the long side", () => {
    expect(projectTileSize("21:9")).toEqual({ width: 280, height: 120 });
  });

  test("a project with no aspect is tall", () => {
    expect(projectTileSize(undefined)).toEqual({ width: 158, height: 280 });
  });
});
