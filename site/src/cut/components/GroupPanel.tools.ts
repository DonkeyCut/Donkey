/**
 * The assistant's group tools — the camera a group's elements are filmed
 * through, the Camera section of `GroupPanel`. The catalog spreads this list
 * into the model's toolset and `aiTools.ts` keys its handlers on
 * `GroupPanelToolName`.
 */

import { CAMERA_SCALE_MAX, CAMERA_SCALE_MIN, CAMERA_WORLD_MAX, CAMERA_WORLD_MIN, EASE_IDS } from "@donkeycut/effects-kit";
import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const GROUP_PANEL_TOOLS = [
  {
    name: "set_group_camera",
    description: `Give a group of elements (titles, shapes, stickers) one camera that moves over them as a single world: steps from card to card, pushes onto the one being talked about, pulls back, whips. Each key is a camera pose at a time in seconds from the group's start (its earliest element): x/y is the world point at the frame's center (frame fractions, where the elements' own x/y live), scale is the zoom (1 = as laid out, 2.5 = a card a few tenths of the frame wide fills it; ${CAMERA_SCALE_MIN}..${CAMERA_SCALE_MAX}), rotation turns the whole world clockwise about the frame center. ease is the curve out of a key into the next (${EASE_IDS.join(", ")}; default linear): sine.inOut glides between cards, power3.out lands a push, power3.inOut over a short gap is a whip. Every element keeps its own keyframes and animation, composed inside the camera. To focus a card, push onto it and blur and dim its neighbours with set_overlay_keyframes keys (blur, opacity) at the same moments. motion_blur streaks what the camera's movement does (shutter sets how hard); an element's own motion_blur (update_overlay) streaks its whole on-screen movement instead. Name the group by group_id or by any member ids. Omitted fields on a key take the camera's pose at that moment; keys replace the whole track; an empty list clears the camera. Group the cards first (group_items), lay them out across and beyond the frame — a grouped element's x/y reaches ${CAMERA_WORLD_MIN}..${CAMERA_WORLD_MAX} — then key the camera.`,
    inputSchema: obj(
      {
        group_id: str("Group id (from editor_state groupCameras or an element's groupId)"),
        ids: { type: "array", items: { type: "string" }, description: "Member ids, in place of group_id: their group takes the camera" },
        keys: {
          type: "array",
          description: "Camera keys in any order; two at the same time collapse to one",
          items: obj(
            {
              t: num("Seconds from the group's start"),
              x: num(`World point at the frame center, fraction of frame width, ${CAMERA_WORLD_MIN}..${CAMERA_WORLD_MAX}`),
              y: num(`World point at the frame center, fraction of frame height, ${CAMERA_WORLD_MIN}..${CAMERA_WORLD_MAX}`),
              scale: num(`Zoom, ${CAMERA_SCALE_MIN}..${CAMERA_SCALE_MAX} (1 = as laid out)`),
              rotation: num("Degrees the world turns clockwise, -180..180"),
              ease: { type: "string", enum: [...EASE_IDS], description: "Curve into the next key" },
            },
            ["t"]
          ),
        },
        motion_blur: bool("Streak the camera's moves (true starts at the default shutter); false switches it off"),
        shutter: num("Motion blur shutter, 0.05..1 of a 30fps frame (0.5 is the usual half-open shutter); setting it switches motion blur on"),
      },
      []
    ),
  },
] as const satisfies readonly AiToolDef[];

export type GroupPanelToolName = (typeof GROUP_PANEL_TOOLS)[number]["name"];
