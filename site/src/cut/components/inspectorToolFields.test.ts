import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GRADE_BASIC_FIELDS } from "@donkeycut/effects-kit";
import { OVERLAY_ANIMATION_TOOLS } from "./AnimationTiles.tools";
import { EFFECTS_TOOLS } from "./EffectsPanel.tools";
import { INSPECTOR_TOOLS } from "./Inspector.tools";
import { TIMELINE_TOOLS } from "./Timeline.tools";
import { TRANSITIONS_TOOLS } from "./TransitionsPanel.tools";

/**
 * Every setting the assistant can write on a selected item has a control in
 * that item's inspector. The tools and the panels write the same document,
 * so a field the panel does not render is a change the person cannot see or
 * undo by hand. A new tool parameter fails here until its control exists —
 * or until it is named below as a placement or identity field, which the
 * timeline shows instead.
 */

/** The tools that change a selected item's own settings. */
const ITEM_TOOLS = new Set([
  "update_overlay",
  "set_mask",
  "set_clip_keyframes",
  "update_audio",
  "set_clip_volume",
  "set_clip_sound",
  "set_framing",
  "set_clip_style",
  "set_speed",
  "set_speed_curve",
  "set_color_grade",
  "set_color_preset",
  "set_color_curves",
  "set_color_wheels",
  "set_color_hsl",
  "set_overlay_animation",
  "set_overlay_keyframes",
  "set_animation",
  "add_effect",
  "update_overlay_video",
  "set_clip_muted",
  "set_clip_hidden",
  "rename_item",
]);

/** The panels that render an item's settings. */
const PANEL_SOURCES = [
  "Inspector.tsx",
  "ColorPanel.tsx",
  "ColorWheel.tsx",
  "SpeedCurveStrip.tsx",
  "RemovalPanel.tsx",
  "AnimationTiles.tsx",
  "TransitionsPanel.tsx",
];

/** Parameters that say which item, or where it sits on the timeline — the
 * timeline is their control. */
const PLACEMENT = new Set([
  "id", "ids", "clipId", "transitionId", "which", "kind", "effect",
  "start", "end", "in", "out", "at", "t", "track", "lane", "layout",
  "region", "region.x", "region.y", "region.w", "region.h",
  "clear", "reset", "reset_all", "auto",
]);

/** A parameter whose panel control reads the document under another name:
 * the identifier the panel source uses for it. */
const PANEL_NAME: Record<string, string> = {
  stroke_color: "stroke",
  stroke_width: "stroke",
  border_width: "border",
  border_color: "border",
  shadow_blur: "blur",
  shadow_x: "shadow",
  shadow_y: "shadow",
  shadow_color: "shadow",
  shadow_opacity: "shadow",
  move_strength: "strength",
  in_style: "AnimationTiles",
  out_style: "AnimationTiles",
  loop_style: "AnimationTiles",
  in_seconds: "seconds",
  out_seconds: "seconds",
  loop_speed: "speed",
  words_style: "words",
  words_color: "words",
  words_scale: "words",
  words_dim: "words",
  style: "ClipAnimationTiles",
  seconds: "seconds",
  smooth: "smoothSlow",
  mode: "clipCovers",
  focus_x: "focus",
  focus_y: "focus",
  "points[].x": "points",
  "points[].y": "points",
  protect_skin: "protect-skin",
  master: "CurveEditor",
  red: "CurveEditor",
  green: "CurveEditor",
  blue: "CurveEditor",
  curve_contrast: "CurveEditor",
  "shadows.dx": "WheelsTool",
  "shadows.dy": "WheelsTool",
  "shadows.luma": "WheelsTool",
  "midtones.dx": "WheelsTool",
  "midtones.dy": "WheelsTool",
  "midtones.luma": "WheelsTool",
  "highlights.dx": "WheelsTool",
  "highlights.dy": "WheelsTool",
  "highlights.luma": "WheelsTool",
  midtones: "WheelsTool",
  band: "HslTool",
  sat: "HslTool",
};

/** The basic grade sliders draw from the registry the tool's parameters are
 * built from, so the panel renders the registry itself. */
const GRADE_FIELD_IDS = new Set<string>(GRADE_BASIC_FIELDS.map((f) => f.key));

const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Every parameter path in a schema: nested objects and array items walk too. */
function paramPaths(schema: unknown, prefix = ""): string[] {
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const out: string[] = [];
  for (const [key, def] of Object.entries(props)) {
    const path = prefix + key;
    out.push(path);
    const d = def as { type?: string; items?: { type?: string } };
    if (d.type === "object") out.push(...paramPaths(d, `${path}.`));
    if (d.type === "array" && d.items?.type === "object") out.push(...paramPaths(d.items, `${path}[].`));
  }
  return out;
}

describe("inspector tool fields", () => {
  test("every item setting the assistant writes has a panel control", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const panels = PANEL_SOURCES.map((f) => readFileSync(`${dir}${f}`, "utf8")).join("\n");
    const rendered = (token: string) => new RegExp(`\\b${token}\\b`).test(panels);
    const tools = [
      ...INSPECTOR_TOOLS,
      ...OVERLAY_ANIMATION_TOOLS,
      ...TRANSITIONS_TOOLS,
      ...EFFECTS_TOOLS,
      ...TIMELINE_TOOLS,
    ].filter((t) => ITEM_TOOLS.has(t.name));
    expect(tools.map((t) => t.name).sort()).toEqual([...ITEM_TOOLS].sort());
    const missing: string[] = [];
    for (const tool of tools) {
      for (const path of paramPaths(tool.inputSchema)) {
        const leaf = path.split(".").pop()!.replace(/\[\]$/, "");
        if (PLACEMENT.has(path) || PLACEMENT.has(leaf)) continue;
        const token =
          PANEL_NAME[path] ??
          (GRADE_FIELD_IDS.has(path) ? "GRADE_BASIC_FIELDS" : undefined) ??
          PANEL_NAME[leaf] ??
          camel(leaf);
        if (!rendered(token)) missing.push(`${tool.name}.${path} (${token})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
