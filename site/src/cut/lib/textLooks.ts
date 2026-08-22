import type { OverlayAnimStyle, OverlayLoopStyle, WordEffectId } from "@donkeycut/effects-kit";
import type { TextEnsemble, TextVariation } from "./textCompose";
import type { CaptionStyleId, FontId } from "./types";

/**
 * Named looks for text-driven videos — lyric videos, kinetic typography,
 * quote cards, anything whose picture is words. One entry describes a whole
 * look: the frame behind the words, the type, how a line arrives and leaves,
 * and the caption settings that carry the same look when the words ride a
 * caption track instead of elements.
 *
 * This registry is the single source: add_text_sequence and set_caption_look
 * take these ids, and the text-videos skill is written from the entries, so a
 * new look becomes a thing the assistant knows the moment it lands here.
 */

export interface TextLook {
  id: string;
  label: string;
  /** What this look is for — the line the assistant picks from. */
  when: string;
  /** The frame behind the words. `background` is the project's frame color.
   * `cards` are full-frame color cards a sequence cycles through, one per
   * line; empty means the words sit straight on the frame or on footage. */
  frame: { background: string; cards: string[] };
  /** This look leaves the project's frame color alone — the words ride over
   * whatever is already there. A caller can still repaint it by asking for
   * the background explicitly. */
  keepsFrame?: boolean;
  /** How far a run in this look departs from one repeated design when the
   * caller names no variation. Absent = `bold`, the designed looks' whole
   * ensemble; `plain` sits at `none` so an unstyled ask stays unstyled. */
  defaultVariation?: TextVariation;
  /** The type. `onCards` is the text color per card color, index-matched to
   * `frame.cards`; without cards, `color` carries every line. */
  text: {
    font: FontId;
    size: number;
    weight: 400 | 700;
    color: string;
    onCards?: string[];
    italic?: boolean;
    letterSpacing?: number;
    lineHeight?: number;
    stroke?: { color: string; width: number };
    plate?: boolean;
    plateColor?: string;
    plateOpacity?: number;
    shadow?: boolean;
    x: number;
    y: number;
    /** Average glyph width as a fraction of the type size, for this face.
     * A sequence uses it to break and size a line so it fits the frame it is
     * actually in — the same 132px that fills a 16:9 frame runs off a 9:16
     * one. Absent = 0.55, an ordinary sans. */
    widthRatio?: number;
  };
  /** The color that marks the word that matters: the karaoke highlight, an
   * accent line, a marker scribble. */
  accent: string;
  /** How each line arrives, leaves, and moves while it holds. */
  motion: {
    in?: { style: OverlayAnimStyle; seconds: number };
    out?: { style: OverlayAnimStyle; seconds: number };
    loop?: { style: OverlayLoopStyle; speed?: number };
  };
  /** What the look does across a whole run rather than on one line: where
   * successive lines land, which faces the run rotates through, which
   * entrances, and the colors a card-less run walks. Entry 0 of every rota
   * repeats the look's own setting, so one line is always the look itself.
   * See textCompose.ts. */
  ensemble: TextEnsemble;
  /** The same look on a caption track — what set_caption_look writes when it
   * is handed this look id. */
  captions: {
    style: CaptionStyleId;
    wordHighlight: boolean;
    size?: number;
    font?: FontId;
    accentColor?: string;
    accentMode?: WordEffectId;
  };
}

export const TEXT_LOOKS: Record<string, TextLook> = {
  plain: {
    id: "plain",
    label: "Plain",
    when: "One clean sans line low in the frame, white with a shadow, a short fade in and out. The look for text the user asked for without asking for a design — same face, same place, same entrance on every line, no cards, and the frame color untouched.",
    frame: { background: "#000000", cards: [] },
    keepsFrame: true,
    defaultVariation: "none",
    text: {
      font: "sf",
      size: 72,
      weight: 700,
      color: "#FFFFFF",
      lineHeight: 1.25,
      shadow: true,
      x: 0.5,
      y: 0.78,
      widthRatio: 0.52,
    },
    accent: "#FFFFFF",
    motion: { in: { style: "fade", seconds: 0.25 }, out: { style: "fade", seconds: 0.2 } },
    ensemble: {
      faces: [{ font: "sf", weight: 700 }],
      motion: ["fade"],
      layout: "center",
      moves: ["none"],
    },
    captions: { style: "clean", wordHighlight: false },
  },

  "lyric-card": {
    id: "lyric-card",
    label: "Lyric cards",
    when: "One line at a time on a full-frame color card, the color changing line to line. The loud, readable default for lyrics and punchy talking-head text.",
    frame: { background: "#111114", cards: ["#111114", "#FFFFFF", "#FF5500"] },
    text: {
      font: "archivo-black",
      size: 104,
      weight: 700,
      color: "#FFFFFF",
      onCards: ["#FFFFFF", "#111114", "#FFFFFF"],
      lineHeight: 1.1,
      shadow: false,
      x: 0.5,
      y: 0.5,
      widthRatio: 0.62,
    },
    accent: "#FF5500",
    motion: { in: { style: "pop", seconds: 0.35 } },
    ensemble: {
      faces: [
        { font: "archivo-black", weight: 700 },
        { font: "impact", weight: 400, scale: 1.14 },
        { font: "space-grotesk", weight: 700, scale: 0.94 },
        { font: "anton", weight: 400, scale: 1.18 },
      ],
      motion: ["pop", "rise", "grow", "bounce", "drop", "zoom"],
      layout: "stack",
      moves: ["none", "push", "settle", "none", "punch", "creep"],
      heroMove: "punch",
      palette: ["#FFE94A", "#FF5500", "#FFFFFF"],
    },
    captions: { style: "punchy", wordHighlight: true, accentColor: "#FF5500" },
  },

  "karaoke-glow": {
    id: "karaoke-glow",
    label: "Karaoke glow",
    when: "The whole line stays up and each word lights as it is sung. The look for singing you can follow — needs word timings, so it rides a caption track.",
    frame: { background: "#0B0B12", cards: [] },
    text: {
      font: "montserrat",
      size: 84,
      weight: 700,
      color: "#FFFFFF",
      lineHeight: 1.2,
      shadow: true,
      x: 0.5,
      y: 0.5,
      widthRatio: 0.56,
    },
    accent: "#FFE94A",
    motion: { in: { style: "fade", seconds: 0.25 }, out: { style: "fade", seconds: 0.25 } },
    ensemble: {
      faces: [{ font: "montserrat", weight: 700 }],
      motion: ["fade"],
      layout: "center",
      moves: ["none", "push"],
      heroMove: "push",
      palette: ["#FFE94A"],
    },
    captions: { style: "highlight", wordHighlight: true, size: 84, accentColor: "#FFE94A" },
  },

  "neon-club": {
    id: "neon-club",
    label: "Neon club",
    when: "Near-black frame, tall condensed caps, an electric accent. Dance, hip-hop, anything with a night to it.",
    frame: { background: "#07070C", cards: [] },
    text: {
      font: "bebas",
      size: 132,
      weight: 400,
      color: "#F5F5FF",
      letterSpacing: 0.04,
      stroke: { color: "#22D3EE", width: 0.02 },
      lineHeight: 1.05,
      shadow: true,
      x: 0.5,
      y: 0.5,
      widthRatio: 0.42,
    },
    accent: "#F0ABFC",
    motion: { in: { style: "streak", seconds: 0.4 }, loop: { style: "flicker", speed: 0.6 } },
    ensemble: {
      faces: [
        { font: "bebas", weight: 400 },
        { font: "oswald", weight: 700, scale: 0.9 },
        { font: "anton", weight: 400, scale: 0.94 },
      ],
      motion: ["streak", "swivel", "flip", "wave", "tumble"],
      layout: "alternate",
      moves: ["push", "driftleft", "none", "sway", "driftright", "creep"],
      heroMove: "slam",
      palette: ["#22D3EE", "#F0ABFC", "#F5F5FF"],
    },
    captions: { style: "neon", wordHighlight: true, accentColor: "#F0ABFC" },
  },

  "marker-note": {
    id: "marker-note",
    label: "Marker note",
    when: "Handwriting on paper, ink arriving as it is written. Personal, confessional, singer-songwriter, or a note-to-camera.",
    frame: { background: "#F4F1E8", cards: ["#F4F1E8"] },
    text: {
      font: "caveat",
      size: 118,
      weight: 700,
      color: "#1B1B1B",
      onCards: ["#1B1B1B"],
      lineHeight: 1.15,
      shadow: false,
      x: 0.5,
      y: 0.48,
      widthRatio: 0.42,
    },
    accent: "#FF5500",
    motion: { in: { style: "typewriter", seconds: 0.5 } },
    ensemble: {
      faces: [
        { font: "caveat", weight: 700 },
        { font: "permanent-marker", weight: 400, scale: 0.82 },
      ],
      motion: ["typewriter", "wave", "rise", "grow"],
      layout: "scatter",
      moves: ["none", "sway", "float", "swing", "none"],
      heroMove: "swing",
      palette: ["#1B1B1B", "#FF5500", "#2563EB"],
    },
    captions: { style: "typewriter", wordHighlight: false, font: "caveat", accentColor: "#FF5500" },
  },

  "serif-mood": {
    id: "serif-mood",
    label: "Serif mood",
    when: "A wide-set serif holding still on black, fading between lines. Ballads, poetry, closing credits, anything slow.",
    frame: { background: "#000000", cards: [] },
    text: {
      font: "dm-serif",
      size: 76,
      weight: 400,
      color: "#F2EDE4",
      letterSpacing: 0.06,
      lineHeight: 1.4,
      shadow: false,
      x: 0.5,
      y: 0.5,
      widthRatio: 0.5,
    },
    accent: "#C9A227",
    motion: { in: { style: "fade", seconds: 0.8 }, out: { style: "fade", seconds: 0.8 } },
    ensemble: {
      faces: [
        { font: "dm-serif", weight: 400 },
        { font: "playfair", weight: 700, scale: 0.96 },
        { font: "dm-serif", weight: 400, italic: true, scale: 0.9 },
      ],
      motion: ["fade", "rise", "converge", "grow"],
      layout: "drift",
      moves: ["push", "float", "pull", "creep", "sink"],
      heroMove: "pull",
      palette: ["#F2EDE4", "#C9A227", "#B7B2A8"],
    },
    captions: { style: "minimal", wordHighlight: false, font: "dm-serif", accentColor: "#C9A227" },
  },

  "type-out": {
    id: "type-out",
    label: "Type out",
    when: "Mono on a dark screen, each line typed in. Explainers, code, anything that should read like a terminal.",
    frame: { background: "#101317", cards: [] },
    text: {
      font: "mono",
      size: 62,
      weight: 400,
      color: "#9BE29B",
      letterSpacing: 0.02,
      lineHeight: 1.5,
      shadow: false,
      x: 0.5,
      y: 0.5,
      widthRatio: 0.6,
    },
    accent: "#F2F2F2",
    motion: { in: { style: "typewriter", seconds: 0.6 } },
    ensemble: {
      faces: [{ font: "mono", weight: 400 }, { font: "space-grotesk", weight: 400, scale: 0.96 }],
      motion: ["typewriter", "wipe", "fade"],
      layout: "ladder",
      moves: ["none", "creep", "none", "push"],
      heroMove: "push",
      palette: ["#9BE29B", "#F2F2F2", "#7DD3FC"],
    },
    captions: { style: "typewriter", wordHighlight: false, font: "mono" },
  },

  "over-footage": {
    id: "over-footage",
    label: "Over footage",
    when: "No cards at all — heavy outlined white type over whatever is playing. The look for words on the user's own video.",
    frame: { background: "#000000", cards: [] },
    keepsFrame: true,
    text: {
      font: "anton",
      size: 96,
      weight: 400,
      color: "#FFFFFF",
      stroke: { color: "#000000", width: 0.035 },
      lineHeight: 1.15,
      shadow: true,
      x: 0.5,
      y: 0.72,
      widthRatio: 0.46,
    },
    accent: "#FFE94A",
    motion: { in: { style: "rise", seconds: 0.35 }, out: { style: "fade", seconds: 0.2 } },
    ensemble: {
      faces: [
        { font: "anton", weight: 400 },
        { font: "impact", weight: 400, scale: 0.96 },
        { font: "archivo-black", weight: 700, scale: 0.82 },
      ],
      motion: ["rise", "pop", "slideleft", "drop", "streak"],
      layout: "alternate",
      moves: ["push", "none", "float", "driftright", "settle"],
      heroMove: "punch",
      palette: ["#FFFFFF", "#FFE94A", "#FF5500"],
    },
    captions: { style: "hook", wordHighlight: true, accentColor: "#FFE94A" },
  },

  "kinetic-scatter": {
    id: "kinetic-scatter",
    label: "Kinetic scatter",
    when: "Letters fly in and settle, the card color shifting under them. Busy, energetic, made to be watched twice.",
    frame: { background: "#1B1036", cards: ["#1B1036", "#2563EB", "#DB2777"] },
    text: {
      font: "poppins",
      size: 98,
      weight: 700,
      color: "#FFFFFF",
      onCards: ["#FFFFFF", "#FFFFFF", "#FFFFFF"],
      lineHeight: 1.1,
      shadow: false,
      x: 0.5,
      y: 0.5,
      widthRatio: 0.58,
    },
    accent: "#FDE047",
    motion: { in: { style: "scatter", seconds: 0.5 }, out: { style: "converge", seconds: 0.3 } },
    ensemble: {
      faces: [
        { font: "poppins", weight: 700 },
        { font: "bangers", weight: 400, scale: 1.18 },
        { font: "montserrat", weight: 700, scale: 0.94 },
        { font: "lobster", weight: 400, scale: 1.04 },
      ],
      motion: ["scatter", "tumble", "bounce", "swivel", "converge", "flip"],
      layout: "scatter",
      moves: ["spring", "swing", "orbit", "punch", "tiltsettle", "fall"],
      heroMove: "slam",
      palette: ["#FDE047", "#FFFFFF", "#38BDF8", "#FB7185"],
    },
    captions: { style: "bubble", wordHighlight: true, accentColor: "#FDE047" },
  },

  "ransom-note": {
    id: "ransom-note",
    label: "Ransom note",
    when: "Every phrase in a different face, tilted, scattered across the frame. Chaotic, hand-cut, pop-punk — the look when the ask is \"make it wild\".",
    frame: { background: "#F5F2EA", cards: [] },
    text: {
      font: "archivo-black",
      size: 110,
      weight: 700,
      color: "#111111",
      lineHeight: 1.05,
      shadow: false,
      x: 0.5,
      y: 0.5,
      widthRatio: 0.62,
    },
    accent: "#E11D48",
    motion: { in: { style: "pop", seconds: 0.18 } },
    ensemble: {
      faces: [
        { font: "archivo-black", weight: 700 },
        { font: "bangers", weight: 400, scale: 1.22 },
        { font: "permanent-marker", weight: 400, scale: 0.92 },
        { font: "playfair", weight: 700, scale: 0.98 },
        { font: "impact", weight: 400, scale: 1.1 },
        { font: "lobster", weight: 400, scale: 1.06 },
      ],
      motion: ["pop", "tumble", "drop", "swivel", "scatter", "flip", "bounce"],
      layout: "scatter",
      moves: ["swing", "punch", "tiltsettle", "orbit", "fall", "spring", "slam"],
      heroMove: "slam",
      palette: ["#111111", "#E11D48", "#2563EB", "#F59E0B", "#111111"],
    },
    captions: { style: "punchy", wordHighlight: true, accentColor: "#E11D48" },
  },

  "stacked-caps": {
    id: "stacked-caps",
    label: "Stacked caps",
    when: "Huge condensed caps climbing the frame, one phrase per rung. Rap verses, manifestos, title sequences that want weight.",
    frame: { background: "#0A0A0A", cards: [] },
    text: {
      font: "anton",
      size: 150,
      weight: 400,
      color: "#FFFFFF",
      letterSpacing: -0.01,
      lineHeight: 0.95,
      shadow: false,
      x: 0.5,
      y: 0.5,
      widthRatio: 0.44,
    },
    accent: "#FF3D00",
    motion: { in: { style: "rise", seconds: 0.3 } },
    ensemble: {
      faces: [
        { font: "anton", weight: 400 },
        { font: "bebas", weight: 400, scale: 1.08 },
        { font: "archivo-black", weight: 700, scale: 0.72 },
      ],
      motion: ["rise", "wipe", "drop", "grow", "streak"],
      layout: "ladder",
      moves: ["push", "none", "creep", "fall", "reveal"],
      heroMove: "slam",
      palette: ["#FFFFFF", "#FF3D00", "#FFFFFF", "#A3A3A3"],
    },
    captions: { style: "block", wordHighlight: true, accentColor: "#FF3D00" },
  },

  "pastel-pop": {
    id: "pastel-pop",
    label: "Pastel pop",
    when: "Soft candy cards and a round friendly face, everything bouncing. Vlogs, cozy songs, anything sweet.",
    frame: { background: "#FFF1F2", cards: ["#FFE4E6", "#DBEAFE", "#FEF9C3", "#DCFCE7"] },
    text: {
      font: "poppins",
      size: 96,
      weight: 700,
      color: "#3F3F46",
      onCards: ["#9F1239", "#1E40AF", "#854D0E", "#166534"],
      lineHeight: 1.15,
      shadow: false,
      x: 0.5,
      y: 0.5,
      widthRatio: 0.58,
    },
    accent: "#FB7185",
    motion: { in: { style: "bounce", seconds: 0.45 } },
    ensemble: {
      faces: [
        { font: "poppins", weight: 700 },
        { font: "rounded", weight: 700, scale: 1.02 },
        { font: "pacifico", weight: 400, scale: 1.08 },
      ],
      motion: ["bounce", "pop", "grow", "wave", "flip"],
      layout: "alternate",
      moves: ["spring", "float", "breathe", "swing", "orbit"],
      heroMove: "spring",
      palette: ["#3F3F46", "#FB7185", "#60A5FA"],
    },
    captions: { style: "bubble", wordHighlight: true, accentColor: "#FB7185" },
  },
};

export const TEXT_LOOK_IDS = Object.keys(TEXT_LOOKS);

/** The look a run takes when the caller named none. Plain: a design is
 * something the user asks for, so an unasked run comes out as one readable
 * face where it was put. */
export const DEFAULT_TEXT_LOOK = "plain";

export function textLook(id: string | undefined): TextLook {
  return TEXT_LOOKS[id ?? ""] ?? TEXT_LOOKS[DEFAULT_TEXT_LOOK];
}

/** The look a caller named, or the default when they named none. An id the
 * registry does not hold throws: a look decides the frame color, the cards,
 * the type and the motion of the whole project, so quietly substituting a
 * different one would redress the video behind the caller's back. */
export function requireTextLook(id: unknown): TextLook {
  if (id === undefined || id === null || id === "") return TEXT_LOOKS[DEFAULT_TEXT_LOOK];
  const look = typeof id === "string" ? TEXT_LOOKS[id] : undefined;
  if (!look)
    throw new Error(`Unknown look "${String(id)}". Use one of: ${TEXT_LOOK_IDS.join(", ")}.`);
  return look;
}

/** The registry as prompt text: one line per look, so the skill teaches
 * whatever the registry currently holds. */
export const textLookCatalog = (): string =>
  TEXT_LOOK_IDS.map((id) => {
    const l = TEXT_LOOKS[id];
    const cards = l.frame.cards.length > 0 ? `cards ${l.frame.cards.join("/")}` : "no cards";
    const frame = l.keepsFrame ? "Frame untouched" : `Frame ${l.frame.background}`;
    return `- ${l.id} (${l.label}): ${l.when} ${frame}, ${cards}; ${l.text.font} ${l.text.size}px; ${l.motion.in?.style ?? "no"} in; ${l.defaultVariation ?? "bold"} by default; captions ${l.captions.style}${l.captions.wordHighlight ? " + karaoke" : ""}.`;
  }).join("\n");
