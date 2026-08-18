import type { OverlayAnimStyle, OverlayLoopStyle, WordAccentMode } from "@donkeycut/effects-kit";
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
  /** The same look on a caption track — what set_caption_look writes when it
   * is handed this look id. */
  captions: {
    style: CaptionStyleId;
    wordHighlight: boolean;
    size?: number;
    font?: FontId;
    accentColor?: string;
    accentMode?: WordAccentMode;
  };
}

export const TEXT_LOOKS: Record<string, TextLook> = {
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
    captions: { style: "typewriter", wordHighlight: false, font: "mono" },
  },

  "over-footage": {
    id: "over-footage",
    label: "Over footage",
    when: "No cards at all — heavy outlined white type over whatever is playing. The look for words on the user's own video.",
    frame: { background: "#000000", cards: [] },
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
    captions: { style: "bubble", wordHighlight: true, accentColor: "#FDE047" },
  },
};

export const TEXT_LOOK_IDS = Object.keys(TEXT_LOOKS);

export const DEFAULT_TEXT_LOOK = "lyric-card";

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
    return `- ${l.id} (${l.label}): ${l.when} Frame ${l.frame.background}, ${cards}; ${l.text.font} ${l.text.size}px; ${l.motion.in?.style ?? "no"} in; captions ${l.captions.style}${l.captions.wordHighlight ? " + karaoke" : ""}.`;
  }).join("\n");
