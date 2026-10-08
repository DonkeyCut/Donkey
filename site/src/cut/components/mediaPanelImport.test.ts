import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Files brought in through the side panel — the Upload button, a drop on the
 * panel or a folder, a library item's Use — stock Project Files and leave the
 * timeline alone. Only a drop on the canvas places a clip.
 */
test("every side-panel import passes mediaOnly", () => {
  const src = readFileSync(fileURLToPath(new URL("./SidePanel.tsx", import.meta.url)), "utf8");
  const calls = [...src.matchAll(/onImport\(([^;]*?)\)\s*(?:;|$|\n|:)/gm)].map((m) => m[1]);
  expect(calls.length).toBeGreaterThan(0);
  const placing = calls.filter((args) => !/mediaOnly:\s*true/.test(args));
  expect(placing).toEqual([]);
});
