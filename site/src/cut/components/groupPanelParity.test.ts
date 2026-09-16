import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The group panel shows the fields every selected item has. Each timeline
 * kind's single-item panel names the plain-value settings a selection of that
 * kind must still be able to set together; a row that exists on one item and
 * vanishes on several is the bug this pins.
 */
const src = readFileSync(fileURLToPath(new URL("./GroupPanel.tsx", import.meta.url)), "utf8");
const inspector = readFileSync(fileURLToPath(new URL("./Inspector.tsx", import.meta.url)), "utf8");

// A row's label as the source spells it, whether on the row, handed to a
// helper, or built from a template; the sound quality row is the inspector's
// own, mounted here.
const names = (label: string) =>
  src.includes(`"${label}"`) || src.includes(`\`${label}`) || (label === "Sound quality" && src.includes("<SoundQualityRow"));

const SHARED: Record<string, string[]> = {
  "video clips": ["Speed", "Reverse", "Volume", "Mute audio", "Sound quality", "Framing", "Zoom", "Flip", "Rotation", "Opacity", "Hidden", "Border", "Shadow"],
  "audio clips": ["Speed", "Reverse", "Volume", "Duck others", "Fade in", "Fade out", "Sound quality", "Hidden"],
  titles: ["Font", "Bold", "Italic", "Align ${a}", "Text size", "Line height", "Letter spacing", "${label} stretch", "Color", "Outline", "Shadow", "Backdrop", "Position", "Rotation", "Opacity", "Hidden"],
  shapes: ["Fill color", "Corner radius", "Outline", "Position", "Rotation", "Opacity", "Hidden"],
  stickers: ["Sticker size", "Position", "Rotation", "Opacity", "Hidden"],
  effects: ["Effect amount", "Depth", "Zoom speed", "Hidden"],
};

describe("group panel parity", () => {
  for (const [kind, rows] of Object.entries(SHARED)) {
    test(`a selection of ${kind} keeps its rows`, () => {
      const missing = rows.filter((r) => !names(r));
      expect(missing).toEqual([]);
    });
  }

  test("a selection of clips opens Color and Animation; elements open Animation", () => {
    expect(/GROUP_CLIP_TABS[\s\S]*?id: "color"[\s\S]*?ANIM_TAB/.test(inspector)).toBe(true);
    expect(inspector).toContain("<ColorPanel clip={groupClips[0]} peers={groupClips} />");
    expect(inspector).toContain("<ClipAnimationPanel clip={groupClips[0]} peers={groupClips} />");
    expect(inspector).toContain("<AnimationPanel overlay={groupOverlays[0]} peers={groupOverlays} />");
  });

  test("an effect carries no transform and skews no selection center", () => {
    expect(src).toContain('const overlays = items.overlays.filter((o) => !isEffectOverlay(o));');
  });
});
