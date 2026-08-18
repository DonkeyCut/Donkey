// The bundled stock catalogs: AI-generated stills and clips that ship with the
// site (files under public/cut-stock and public/cut-stock-video, manifests in
// stockManifest.ts and stockVideoManifest.ts). Each entry keeps the exact
// prompt that produced it — clicking a stock tile copies that prompt into the
// generate panel beside it for the user to edit and re-render on their account.
// Regenerate or extend the sets with `bun scripts/generate-stock-images.ts`
// and `bun scripts/generate-stock-videos.ts`.

export type StockAspect = "16:9" | "9:16" | "1:1";

export interface StockImage {
  id: string;
  category: StockCategory;
  /** The generation prompt, saved verbatim — the editable starting point. */
  prompt: string;
  /** Vision-extracted keywords for the visible content (objects, setting,
   * subjects) — what the search box matches beyond the prompt text. */
  tags: string[];
  aspect: StockAspect;
  /** Site-relative full-asset URL (under /cut-stock/) — lightbox, refs, timeline. */
  file: string;
  /** Small grid thumbnail URL for the browse panel. */
  thumb: string;
}

/** Video renders landscape and portrait only — no square video. */
export type StockVideoAspect = "16:9" | "9:16";

export interface StockVideo {
  id: string;
  category: StockVideoCategory;
  /** The generation prompt, saved verbatim — the editable starting point. */
  prompt: string;
  /** Characters only: the person description, kept separate from the spoken
   * line so the generate panel can put new words in the same mouth. */
  persona?: string;
  /** Vision-extracted keywords for the visible content (objects, setting,
   * subjects) — what the search box matches beyond the prompt text. */
  tags: string[];
  aspect: StockVideoAspect;
  /** Site-relative mp4 URL (under /cut-stock-video/) — playback, refs, timeline. */
  file: string;
  /** Poster-frame thumbnail URL for the browse grid. */
  thumb: string;
  /** Rendered length in seconds. */
  duration: number;
}

/** Pregenerated background-music beds (Gemini/Lyria), bundled under
 * public/cut-stock-music with the manifest in stockMusicManifest.ts. Regenerate
 * or extend the set with `bun scripts/generate-stock-music.ts`. */
export interface StockMusic {
  id: string;
  category: StockMusicCategory;
  /** The generation prompt, saved verbatim — the editable starting point. */
  prompt: string;
  /** Mood/genre/instrument keywords the search box matches beyond the prompt. */
  tags: string[];
  /** Site-relative mp3 URL (under /cut-stock-music/) — preview and timeline. */
  file: string;
  /** Rendered length in seconds. */
  duration: number;
  /** Normalized 0..1 waveform peaks for the card, precomputed at generation. */
  peaks: number[];
}

/** Nominal pixel size for a stock clip's aspect. The catalog stores only the
 * ratio; these stand in until the file's real dimensions are probed, and all
 * that reads them before then is orientation (the first-asset aspect guess)
 * and framing math, which only use the ratio. */
export const stockAspectDims = (aspect: StockVideoAspect): { width: number; height: number } =>
  aspect === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };

/** Width ÷ height behind a catalog aspect label, for surfaces that size
 * themselves from the ratio alone. */
export const aspectRatio = (aspect: StockAspect): number =>
  aspect === "9:16" ? 9 / 16 : aspect === "1:1" ? 1 : 16 / 9;

export const STOCK_MUSIC_CATEGORIES = [
  "Songs",
  "Cinematic",
  "Ambient",
  "Acoustic",
  "Electronic",
  "Upbeat",
  "Chill",
  "Corporate",
  "Piano",
] as const;

export type StockMusicCategory = (typeof STOCK_MUSIC_CATEGORIES)[number];

export const STOCK_CATEGORIES = [
  "Business",
  "Nature",
  "Travel",
  "City",
  "Technology",
  "Anime",
  "Animal",
  "Food & Drink",
] as const;

export type StockCategory = (typeof STOCK_CATEGORIES)[number];

/** Video adds a catalog-only "Characters" section: talking-head clips whose
 * prompts carry an editable spoken line (the model generates the dialogue audio). */
export const STOCK_VIDEO_CATEGORIES = ["Characters", ...STOCK_CATEGORIES] as const;

export type StockVideoCategory = (typeof STOCK_VIDEO_CATEGORIES)[number];

export const STOCK_ASPECT_LABEL: Record<StockAspect, string> = {
  "16:9": "Landscape (16:9)",
  "9:16": "Portrait (9:16)",
  "1:1": "Square (1:1)",
};

/** A readable title from a stock id, e.g. "nature-waves" → "Nature Waves". */
export const stockTitle = (id: string) =>
  id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The talking-character prompt: a persona plus the line they speak. One
 * template shared by the catalog generator and the editor's character mode, so
 * a character says new words in the same style the stock clip shows. The
 * register is deliberately UGC, not cinematic — tight selfie framing, ordinary
 * light, imperfect handheld feel is what makes the people read as real. */
export const characterPrompt = (persona: string, line: string) =>
  `A casual selfie video recorded on a phone front camera: ${persona}, framed in a tight close-up with the face filling most of the frame, looking into the lens and talking mid-conversation, candid and unposed. They say: "${line}" Ordinary available light, true-to-life skin texture with pores and small imperfections, slightly shaky handheld framing, the look of real user-generated footage. No text, no watermarks, no captions.`;
