import { creditStringToMicros } from "@/lib/credits/amounts";
import { creditsFromDollars, creditsPerDollar } from "@/lib/credits/format-credits";

// What a flat-priced generation costs before it runs, keyed by what the editor
// offers (a video size and length, a music length). The server prices each
// entry as one whole request through the charge's own rate lookup, so the
// number on the Generate button is the number billed. This module carries no
// model ids or rates: the page reads the sheet from /api/credits/prices.

/** The music lengths the generator offers. */
export const musicLengths = ["clip", "song"] as const;
export type MusicLength = (typeof musicLengths)[number];

/** A video render that names no length bills the model's longest clip. */
export const autoVideoLength = "auto";

/** One request of each generation, as dollar strings exact to the micro. */
export type CreditPriceSheet = {
  /** A whole render by resolution, then by length in seconds or "auto". */
  video: Record<string, Record<string, string>>;
  /** One generated image. */
  image: string;
  /** One music track per length. */
  music: Record<MusicLength, string>;
  /** A minute of synthesized speech. */
  speechMinute: string;
};

/** Micros a video render costs; null for a size or length the sheet lacks. */
export function videoRenderMicros(
  sheet: CreditPriceSheet,
  resolution: string,
  durationSeconds: number | null,
): bigint | null {
  const length = durationSeconds === null ? autoVideoLength : String(durationSeconds);
  const price = sheet.video[resolution]?.[length];
  return price === undefined ? null : creditStringToMicros(price);
}

/** Micros for `count` separate image requests. */
export function imageMicros(sheet: CreditPriceSheet, count: number): bigint {
  return creditStringToMicros(sheet.image) * BigInt(count);
}

/** Micros for `takes` separate music requests of one length. */
export function musicMicros(sheet: CreditPriceSheet, length: MusicLength, takes: number): bigint {
  return creditStringToMicros(sheet.music[length]) * BigInt(takes);
}

/** The sheet in whole credits, rounded up, as the assistant quotes it. */
export type CreditPriceQuote = {
  creditsPerDollar: number;
  video: Record<string, Record<string, number>>;
  image: number;
  music: Record<MusicLength, number>;
  voiceoverPerMinute: number;
};

/** Every sheet entry in whole credits. */
export function creditPriceQuote(sheet: CreditPriceSheet): CreditPriceQuote {
  const credits = (dollars: string) => creditsFromDollars(dollars, "up");
  const video = Object.fromEntries(
    Object.entries(sheet.video).map(([resolution, byLength]) => [
      resolution,
      Object.fromEntries(Object.entries(byLength).map(([length, price]) => [length, credits(price)])),
    ]),
  );
  return {
    creditsPerDollar,
    video,
    image: credits(sheet.image),
    music: { clip: credits(sheet.music.clip), song: credits(sheet.music.song) },
    voiceoverPerMinute: credits(sheet.speechMinute),
  };
}
