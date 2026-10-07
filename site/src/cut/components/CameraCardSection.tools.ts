/**
 * The assistant's camera-card tool: the talking-head split layout, in any
 * frame shape, that the Inspector's Camera card section sets on a video
 * clip. Kept beside the section; the catalog spreads this list into the
 * model's toolset and `aiTools.ts` keys its handler on `CameraCardToolName`.
 * Defaults and ranges come from the same constants the section renders from.
 */

import { bool, ids, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
import {
  CARD_BLEED_MAX,
  CARD_DEFAULTS,
  CARD_FEATHER_MAX,
  CARD_OFFSET_MAX,
  CARD_RADIUS_MAX,
  CARD_SCALE_MAX,
  CARD_SCALE_MIN,
  CARD_SIDES,
  CARD_TOP_MAX,
  CARD_TOP_MIN,
  CARD_WIDTH_MAX,
  CARD_WIDTH_MIN,
  defaultCardWidth,
} from "@/cut/lib/cameraCard";

export const CAMERA_CARD_TOOLS = [
  {
    name: "set_camera_card",
    description: `Lay a video clip out as a camera card, the split section of a talking-head video in any frame shape: a graphic fills the frame and the speaker shows in a rounded card that bleeds off the frame edge, with their head popping out above the card's top edge. \`side\` picks where the card sits: bottom runs it across the bottom, the layout for portrait frames; left or right stands it up that side, ${Math.round(defaultCardWidth(21 / 9) * 100)}–${Math.round(defaultCardWidth(1) * 100)}% of the frame wide by default, the layout for square and landscape frames, where a full-width card leaves the graphic a strip. Left out, the side follows the frame shape, so the card stays right when the project changes shape; pass \`side: "auto"\` to hand a picked side back to the frame. Put the side card opposite the graphic's subject. \`top\` and \`width\` default from the side, the frame and the source, and passing \`side\` lets them default again unless the call names them too. One clip draws both the card and the head from the same frame, so they never drift; the head is the clip's own footage keyed by the free on-device person matte, which this call starts baking; editor_state reports its readiness under \`card.matte\`. Until the matte lands the card shows without the head. The graphic, an image or b-roll, sits on a lower track than the speaker's clip and fills the frame behind the card. The card places the footage itself: the defaults scale and position it from the source's aspect so the head clears the card top, portrait and landscape alike, and \`scale\`/\`offset_x\`/\`offset_y\` adjust from there; the clip's framing zoom, pan and box style stand aside while the card is on. Only the fields you pass change; the first call fills the rest with the defaults. \`clear: true\` turns the card off and the clip frames as before.`,
    inputSchema: obj({
      clipId: str("Video clip id"),
      ids: ids("clipId"),
      clear: bool("Turn the card layout off"),
      side: {
        type: "string",
        enum: [...CARD_SIDES, "auto"],
        description: "Where the card sits: bottom, left or right; auto follows the frame shape (bottom in a portrait frame, right in a square or landscape one)",
      },
      top: num(
        `Card top edge, fraction of the clip's box height from the top, ${CARD_TOP_MIN}..${CARD_TOP_MAX} (default from the side, the frame and the source)`
      ),
      width: num(
        `A left or right card's width in view, fraction of the box width, ${CARD_WIDTH_MIN}..${CARD_WIDTH_MAX} (default from the frame shape)`
      ),
      radius: num(`Top corner radius, design px at the 1080 short side, 0..${CARD_RADIUS_MAX} (default ${CARD_DEFAULTS.radius})`),
      side_bleed: num(
        `How far the card reaches past the frame edges it bleeds off, design px, 0..${CARD_BLEED_MAX} (default ${CARD_DEFAULTS.sideBleed})`
      ),
      pop_out: bool(`The speaker's head shows above the card (default ${CARD_DEFAULTS.popOut})`),
      feather: num(
        `How far below the card's top edge the head fades out, design px, 0..${CARD_FEATHER_MAX} (default ${CARD_DEFAULTS.feather})`
      ),
      shadow: num(`Card shadow opacity 0..1, 0 for none (default ${CARD_DEFAULTS.shadow})`),
      scale: num(`Footage size over the default placement, ${CARD_SCALE_MIN}..${CARD_SCALE_MAX} (default 1)`),
      offset_x: num(`Footage shift right, fraction of the clip's box width, -${CARD_OFFSET_MAX}..${CARD_OFFSET_MAX} (default 0)`),
      offset_y: num(`Footage shift down, fraction of the clip's box height, -${CARD_OFFSET_MAX}..${CARD_OFFSET_MAX} (default 0)`),
    }),
  },
] as const satisfies readonly AiToolDef[];

export type CameraCardToolName = (typeof CAMERA_CARD_TOOLS)[number]["name"];
