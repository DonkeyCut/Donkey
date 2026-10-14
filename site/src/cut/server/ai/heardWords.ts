import type { Cue } from "../transcribe";

const DATA_URL = /^data:[^,]*;base64,([^]*)$/;

/** The file name the speech tool reads a sound under, from the container its
 * bytes open with: the labelled media type can be a guess (a whole file
 * served as octet-stream comes back labelled AAC). Null for a container the
 * Mac's audio reader does not open, e.g. Ogg. */
function speechFileName(bytes: Uint8Array): string | null {
  const ascii = (at: number, text: string) =>
    text.split("").every((c, i) => bytes[at + i] === c.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) {
    return "span.wav";
  }
  if (ascii(4, "ftyp")) {
    return "span.m4a";
  }
  if (ascii(0, "fLaC")) {
    return "span.flac";
  }
  if (ascii(0, "FORM")) {
    return "span.aiff";
  }
  if (ascii(0, "caff")) {
    return "span.caf";
  }
  if (ascii(0, "ID3")) {
    return "span.mp3";
  }
  // A frame sync: ADTS AAC carries layer bits 00, an MPEG audio frame does not.
  if (bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0 && (bytes[1] & 0x06) === 0) {
    return "span.aac";
  }
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return "span.mp3";
  }
  return null;
}

const HEARD_AS_WORDS =
  "You take sound as its words: this stretch was transcribed on this Mac, each line timed in source seconds. Tone, music and delivery do not come through, so judge those from the picture or say you cannot.";

type Transcribe = (
  audio: Uint8Array,
  opts: { locale?: string; duration?: number; fileName?: string }
) => Promise<Cue[]>;

const round = (n: number) => Math.round(n * 1000) / 1000;

/** A listen_audio result for a chat model that reads text and pictures only:
 * the stretch's sound becomes the words over it. A result with no sound
 * passes through. */
export async function audioAsWords(output: unknown, transcribe: Transcribe): Promise<unknown> {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return output;
  }
  const { audio, ...rest } = output as Record<string, unknown>;
  const m = typeof audio === "string" ? DATA_URL.exec(audio) : null;
  if (!m) {
    return output;
  }

  // The stretch starts at `from` in source seconds and runs to `coveredTo`.
  const from = typeof rest.from === "number" ? rest.from : 0;
  const to = typeof rest.coveredTo === "number" ? rest.coveredTo : undefined;
  const bytes = new Uint8Array(Buffer.from(m[1], "base64"));
  const fileName = speechFileName(bytes);
  if (!fileName) {
    throw new Error("This sound's format can't be transcribed on this Mac.");
  }
  const cues = await transcribe(bytes, {
    ...(typeof rest.locale === "string" ? { locale: rest.locale } : {}),
    ...(to !== undefined ? { duration: round(to - from) } : {}),
    fileName,
  });
  return {
    ...rest,
    heard: HEARD_AS_WORDS,
    words: cues.map((c) => ({ start: round(from + c.start), end: round(from + c.end), text: c.text })),
  };
}
