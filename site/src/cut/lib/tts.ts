"use client";

import { geminiModelRoleNames } from "@/lib/inference/gemini-models";
import { bytesFromBase64 } from "./bytes";
import { NO_CREDITS_MESSAGE } from "./credits";
import { hostedPost } from "./hosted";
import { importFileToProject } from "./media";
import { mediaSlug, type MediaAsset } from "./types";
import {
  DEFAULT_VOICE,
  resolveVoice,
  SPEECH_VOICES,
  VOICE_SAMPLE_TEXT,
  type SpeechVoice,
} from "./voices";

// The voice catalog lives in the dependency-light `voices` module (shared with
// the build script); re-exported here so existing importers keep working.
export { DEFAULT_VOICE, resolveVoice, SPEECH_VOICES, type SpeechVoice };

// Client side of AI voiceovers: Gemini speech generation on Donkey's hosted
// inference routes, with the user's Donkey sign-in and credits (same-origin on
// the cut hosts, like image/video generation). Each segment comes back as raw
// PCM; the browser lays the segments out at their timeline offsets, encodes
// one WAV, and saves it into the project through the local engine like any
// other media file.

export interface SpeechSegment {
  text: string;
  /** Timeline offset this line should land at, seconds. */
  at: number;
}

export interface SpeechLanguage {
  id: string;
  label: string;
  /** Voice-picker sample line, written natively in the language. */
  sample: string;
}

// The neutral sample line, shared with the persona catalog; also the default
// text for every language whose own sample is not written out below.
const SAMPLE_TEXT = VOICE_SAMPLE_TEXT;

/** Languages the speech model speaks (BCP-47, fixed by the model). "auto" lets
 * the model match the text; a concrete pick pins pronunciation and picks the
 * sample line's language. */
export const SPEECH_LANGUAGES: SpeechLanguage[] = [
  { id: "auto", label: "Auto — match the text", sample: SAMPLE_TEXT },
  { id: "ar-EG", label: "Arabic", sample: "هذا هو صوتي. لنصنع شيئًا يستحق التذكر." },
  { id: "bn-BD", label: "Bengali", sample: "আমার কণ্ঠ এমনই শোনায়। চলুন মনে রাখার মতো কিছু তৈরি করি।" },
  { id: "nl-NL", label: "Dutch", sample: "Zo klink ik. Laten we iets maken dat het onthouden waard is." },
  { id: "en-US", label: "English", sample: SAMPLE_TEXT },
  { id: "en-IN", label: "English (India)", sample: SAMPLE_TEXT },
  { id: "fr-FR", label: "French", sample: "Voici comment je sonne. Créons quelque chose d'inoubliable." },
  { id: "de-DE", label: "German", sample: "So klinge ich. Lass uns etwas Unvergessliches schaffen." },
  { id: "hi-IN", label: "Hindi", sample: "मेरी आवाज़ ऐसी है। चलिए कुछ यादगार बनाते हैं।" },
  { id: "id-ID", label: "Indonesian", sample: "Seperti inilah suara saya. Mari membuat sesuatu yang layak dikenang." },
  { id: "it-IT", label: "Italian", sample: "Questa è la mia voce. Creiamo qualcosa che valga la pena ricordare." },
  { id: "ja-JP", label: "Japanese", sample: "これが私の声です。記憶に残るものを作りましょう。" },
  { id: "ko-KR", label: "Korean", sample: "제 목소리는 이렇습니다. 기억에 남을 만한 것을 만들어 봅시다." },
  { id: "mr-IN", label: "Marathi", sample: "माझा आवाज असा आहे. चला काहीतरी संस्मरणीय बनवूया." },
  { id: "pl-PL", label: "Polish", sample: "Tak brzmi mój głos. Stwórzmy coś wartego zapamiętania." },
  { id: "pt-BR", label: "Portuguese", sample: "Esta é a minha voz. Vamos criar algo que valha a pena lembrar." },
  { id: "ro-RO", label: "Romanian", sample: "Așa sună vocea mea. Să creăm ceva demn de amintit." },
  { id: "ru-RU", label: "Russian", sample: "Вот как звучит мой голос. Давайте создадим что-то запоминающееся." },
  { id: "es-US", label: "Spanish", sample: "Así sueno. Hagamos algo digno de recordar." },
  { id: "ta-IN", label: "Tamil", sample: "என் குரல் இப்படித்தான் ஒலிக்கிறது. நினைவில் நிற்கும் ஒன்றை உருவாக்குவோம்." },
  { id: "te-IN", label: "Telugu", sample: "నా గొంతు ఇలా వినిపిస్తుంది. గుర్తుండిపోయేది ఒకటి చేద్దాం." },
  { id: "th-TH", label: "Thai", sample: "เสียงของฉันเป็นแบบนี้ มาสร้างสิ่งที่น่าจดจำกันเถอะ" },
  { id: "tr-TR", label: "Turkish", sample: "Sesim böyle. Hatırlanmaya değer bir şey yapalım." },
  { id: "uk-UA", label: "Ukrainian", sample: "Ось як звучить мій голос. Створімо щось варте пам'яті." },
  { id: "vi-VN", label: "Vietnamese", sample: "Giọng của tôi nghe như thế này. Hãy cùng tạo nên điều gì đó đáng nhớ." },
];

export const DEFAULT_LANGUAGE = "auto";

/** Resolve a requested speech language against the catalog: an exact
 * (case-insensitive) BCP-47 match, else a bare language ("es") to its catalog
 * variant, else auto-detect. Shared by every generation surface and the AI
 * copilot so a loose ask still lands on a supported code. */
export function resolveLanguage(wanted?: string): string {
  const w = wanted?.trim().toLowerCase();
  if (!w || w === "auto") return DEFAULT_LANGUAGE;
  const exact = SPEECH_LANGUAGES.find((l) => l.id.toLowerCase() === w);
  if (exact) return exact.id;
  const bare = SPEECH_LANGUAGES.find((l) => l.id.toLowerCase().startsWith(`${w}-`));
  return bare?.id ?? DEFAULT_LANGUAGE;
}

/** What a free-text voice direction resolves to once a model has read it. */
export interface VoiceoverPlan {
  /** Lines to speak, in order — translated into `language` when the direction
   * asked to speak in another tongue, otherwise the originals unchanged. */
  texts: string[];
  /** Delivery instruction with any "say it in X" language ask removed. */
  direction?: string;
  /** BCP-47 code to pin pronunciation: the language the direction named, or the
   * caller's picked language when it named none. */
  language?: string;
}

const PLAN_INSTRUCTIONS = `You prepare a voiceover before a text-to-speech voice reads it.

You get a delivery DIRECTION (free text about how to say it) and the LINES to speak. Decide whether the direction asks for the lines to be spoken in a specific language that differs from the language they are already written in.

Respond with ONLY a JSON object — no prose, no code fences:
{
  "language": string | null,  // BCP-47 tag (e.g. "ko-KR", "es-US", "ja-JP") when the direction asks to speak in a language; otherwise null
  "delivery": string | null,  // the direction with any language request removed (e.g. "warmly"); null if nothing about delivery is left
  "lines": string[] | null    // the LINES translated into "language", same count and order; null when no translation is needed
}

Rules:
- Set "language" only when the direction actually asks to speak in a language ("say it in Korean", "in Spanish", "read this in Japanese").
- When you set "language", translate every line into it, preserving meaning, tone, punctuation, and inline tags like [whispers]. Keep the same number of lines in the same order.
- When the direction is only about tone, pace, or energy ("say warmly"), return "language": null and "lines": null and put the whole direction in "delivery".
- When the direction is empty, return {"language": null, "delivery": null, "lines": null}.`;

/** Read a free-text voice direction for a target language and, when it names
 * one, translate the lines into it. The direction is natural language ("say it
 * in Korean, warmly"), so a model — not string matching — decides whether a
 * language was asked for; the returned plan carries the (possibly translated)
 * lines, the resolved BCP-47 code, and the direction with the language ask
 * stripped out. With no direction there is nothing to read, so the inputs pass
 * through unchanged and no round-trip happens. Any failure falls back to the
 * inputs so a generation never breaks on the prep step. */
export async function planVoiceover(
  texts: string[],
  opts: { direction?: string; language?: string }
): Promise<VoiceoverPlan> {
  const direction = opts.direction?.trim();
  const passthrough: VoiceoverPlan = { texts, direction, language: opts.language };
  if (!direction) return passthrough;
  try {
    const res = await hostedPost("/api/inference/responses", {
      donkeyProvider: "gemini",
      model: geminiModelRoleNames.chat,
      instructions: PLAN_INSTRUCTIONS,
      input: [{ role: "user", content: [{ text: JSON.stringify({ direction, lines: texts }) }] }],
    });
    if (!res.ok) return passthrough;
    const body = (await res.json()) as { output_text?: string };
    const plan = parsePlan(body.output_text);
    if (!plan) return passthrough;

    const language =
      typeof plan.language === "string" && plan.language.trim()
        ? resolveLanguage(plan.language)
        : opts.language;
    const translated =
      Array.isArray(plan.lines) && plan.lines.length === texts.length
        ? plan.lines.filter((l): l is string => typeof l === "string" && l.trim().length > 0)
        : [];
    const lines = translated.length === texts.length ? translated : texts;
    const delivery = typeof plan.delivery === "string" ? plan.delivery.trim() : "";
    return { texts: lines, direction: delivery || undefined, language };
  } catch {
    return passthrough;
  }
}

/** Pull the plan JSON out of the model's reply, tolerating a code fence. */
function parsePlan(
  text: string | undefined
): { language?: unknown; delivery?: unknown; lines?: unknown } | null {
  if (!text) return null;
  const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const MAX_SEGMENTS = 200;
const MAX_SEGMENT_CHARS = 2000;
const MAX_TOTAL_CHARS = 20000;
/** Hosted synthesis calls in flight at once for multi-line readouts. */
const CONCURRENCY = 3;

interface PcmClip {
  samples: Int16Array;
  rate: number;
}

/** The account balance can't cover the generation — callers surface a link to
 * buy credits alongside the message. */
export class NoCreditsError extends Error {}

async function readError(res: Response, fallback: string): Promise<string> {
  if (res.status === 401) return "Sign in to Donkey to generate voiceovers.";
  const body = (await res.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
    details?: { message?: unknown };
  } | null;
  const message = [body?.message, body?.error].find(
    (v): v is string => typeof v === "string" && v.length > 0
  );
  if (res.status === 402) return NO_CREDITS_MESSAGE;
  // The provider's own error (`details.message`) names the actual rejection
  // ("input too long", a rate limit, …); the top-level message is generic.
  const detail = body?.details?.message;
  const full =
    message && typeof detail === "string" && detail && detail !== message
      ? `${message} (${detail})`
      : message;
  return full ?? fallback;
}

/** One hosted Gemini speech call: text in, decoded PCM out. A direction is a
 * natural-language delivery instruction ("Say warmly, like an old friend");
 * the model also honors inline tags like [whispers] in the text itself. */
async function synthesizeSegment(
  text: string,
  voice: string,
  direction?: string,
  language?: string
): Promise<PcmClip> {
  const style = direction?.trim();
  const languageCode = resolveLanguage(language);
  const res = await hostedPost("/api/inference/assets", {
    kind: "speech",
    prompt: style ? `${style}: ${text}` : text,
    inputs: { voice },
    ...(languageCode !== DEFAULT_LANGUAGE
      ? { parameters: { languageCode } }
      : {}),
  });
  if (!res.ok) {
    const message = await readError(res, "Voice generation failed.");
    throw res.status === 402 ? new NoCreditsError(message) : new Error(message);
  }
  const gen = (await res.json()) as {
    outputs?: { dataBase64?: string; contentType?: string }[];
  };
  const out = gen.outputs?.find((o) => o.dataBase64);
  if (!out?.dataBase64) throw new Error("The provider returned no audio.");

  const bytes = bytesFromBase64(out.dataBase64);
  const rate = Number(out.contentType?.match(/rate=(\d+)/)?.[1]) || 24000;
  // Gemini TTS returns raw little-endian 16-bit mono PCM.
  return { samples: new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1), rate };
}

/** Nearest-neighbor resample, only for the off chance segments disagree. */
function resample(clip: PcmClip, rate: number): PcmClip {
  if (clip.rate === rate) return clip;
  const out = new Int16Array(Math.round((clip.samples.length * rate) / clip.rate));
  for (let i = 0; i < out.length; i++) {
    out[i] = clip.samples[Math.min(clip.samples.length - 1, Math.round((i * clip.rate) / rate))];
  }
  return { samples: out, rate };
}

/** Lay the clips out at their offsets (summing any overlap, clamped) and wrap
 * the result in a WAV container. */
function assembleWav(clips: PcmClip[], offsets: number[]): Blob {
  const rate = clips[0].rate;
  const aligned = clips.map((c) => resample(c, rate));
  const starts = offsets.map((o) => Math.round(o * rate));
  const total = Math.max(...aligned.map((c, i) => starts[i] + c.samples.length));

  const mix = new Int32Array(total);
  aligned.forEach((c, i) => {
    const from = starts[i];
    for (let j = 0; j < c.samples.length; j++) mix[from + j] += c.samples[j];
  });

  const data = new Int16Array(total);
  for (let i = 0; i < total; i++) {
    data[i] = Math.max(-32768, Math.min(32767, mix[i]));
  }

  const header = new DataView(new ArrayBuffer(44));
  const write = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) header.setUint8(at + i, s.charCodeAt(i));
  };
  write(0, "RIFF");
  header.setUint32(4, 36 + data.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  write(36, "data");
  header.setUint32(40, data.byteLength, true);
  return new Blob([header.buffer, data.buffer], { type: "audio/wav" });
}

export interface SpeechLayout {
  /** The spoken line's text (translated when the direction asked), so callers
   * can match a line back to its cue. */
  text: string;
  /** Timeline second this line's audio starts at. */
  at: number;
  /** How long the generated audio for this line runs, seconds. */
  duration: number;
}

/**
 * Synthesize segments into one WAV clip. The direction is read for a target
 * language and the lines translated when asked (planVoiceover), each line is
 * spoken, and the clips are laid out into a single WAV whose t=0 is the
 * earliest segment. `offset` is that earliest timeline time; `layout` reports
 * where each line landed so callers can re-time their cues. This is the shared
 * core behind every voiceover surface — the timeline asset, the subtitles
 * readout, and the in-panel preview — so language handling is identical
 * everywhere.
 */
/** The locale a text will be SPOKEN in, read from its writing system. For a
 * non-Latin script the letters are definitive — Hangul speaks Korean whatever
 * any language picker says. Latin scripts can't be told apart this way, so
 * they return undefined and the planned/picked language decides. */
export function scriptSpokenLocale(text: string): string | undefined {
  const scripts: [RegExp, string][] = [
    [/[぀-ヿ]/gu, "ja-JP"], // kana first: Japanese also uses Han
    [/[가-힯ᄀ-ᇿ㄰-㆏]/gu, "ko-KR"],
    [/[一-鿿]/gu, "zh-CN"],
    [/[Ѐ-ӿ]/gu, "ru-RU"],
    [/[؀-ۿ]/gu, "ar-SA"],
    [/[֐-׿]/gu, "he-IL"],
    [/[฀-๿]/gu, "th-TH"],
    [/[ऀ-ॿ]/gu, "hi-IN"],
    [/[Ͱ-Ͽ]/gu, "el-GR"],
  ];
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters === 0) return undefined;
  for (const [re, locale] of scripts) {
    const count = (text.match(re) ?? []).length;
    if (count >= 4 && count / letters >= 0.2) return locale;
  }
  return undefined;
}

export async function renderSpeechClip(
  segments: SpeechSegment[],
  opts: { voice: string; direction?: string; language?: string }
): Promise<{ blob: Blob; offset: number; layout: SpeechLayout[]; language?: string }> {
  const raw = segments
    .map((s) => ({ text: s.text.trim(), at: Math.max(0, s.at) }))
    .filter((s) => s.text);
  if (raw.length === 0) throw new Error("Nothing to say.");
  if (raw.length > MAX_SEGMENTS) throw new Error(`At most ${MAX_SEGMENTS} lines at once.`);
  if (raw.some((s) => s.text.length > MAX_SEGMENT_CHARS)) {
    throw new Error(`Each line must stay under ${MAX_SEGMENT_CHARS} characters.`);
  }
  if (raw.reduce((n, s) => n + s.text.length, 0) > MAX_TOTAL_CHARS) {
    throw new Error(`The script must stay under ${MAX_TOTAL_CHARS} characters.`);
  }

  // The one place a free-text direction becomes speech settings: a model reads
  // it for a "say it in X" ask and translates the lines when it names a
  // language, so the voice speaks the translation rather than English with an
  // accent. No direction → passthrough, no round-trip.
  const plan = await planVoiceover(
    raw.map((l) => l.text),
    { direction: opts.direction, language: opts.language }
  );
  const lines = raw.map((l, i) => ({ text: plan.texts[i] ?? l.text, at: l.at }));

  const offset = Math.min(...lines.map((s) => s.at));
  const voice = resolveVoice(opts.voice);

  // A small pool: readouts can be dozens of lines, one hosted call each.
  const clips: PcmClip[] = new Array(lines.length);
  let next = 0;
  const worker = async () => {
    while (next < lines.length) {
      const i = next++;
      try {
        try {
          clips[i] = await synthesizeSegment(lines[i].text, voice, plan.direction, plan.language);
        } catch (e) {
          // An empty balance repeats forever — resending only burns the queue.
          if (e instanceof NoCreditsError) throw e;
          // The TTS backend rejects the odd call spuriously; one resend of just
          // this line usually lands and saves the rest of the batch.
          clips[i] = await synthesizeSegment(lines[i].text, voice, plan.direction, plan.language);
        }
      } catch (e) {
        // Name the line that failed so a one-bad-cue batch is actionable.
        if (lines.length > 1 && e instanceof Error && !(e instanceof NoCreditsError)) {
          const snippet = lines[i].text.length > 40 ? `${lines[i].text.slice(0, 40)}…` : lines[i].text;
          throw new Error(`Line ${i + 1} ("${snippet}"): ${e.message}`);
        }
        throw e;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, lines.length) }, worker)
  );

  // Each line lands at its cue offset — unless the previous line's speech runs
  // past it. The generated pace differs from the original recording, so such
  // overlaps are common; mixed as-is they'd play two voice lines at once. The
  // pushed-back starts are reported in `layout` so callers re-time their cues.
  const placed: number[] = [];
  let cursor = 0;
  lines.forEach((l, i) => {
    const at = Math.max(l.at - offset, cursor);
    placed.push(at);
    cursor = at + clips[i].samples.length / clips[i].rate;
  });

  const blob = assembleWav(clips, placed);
  const layout: SpeechLayout[] = lines.map((l, i) => ({
    text: l.text,
    at: offset + placed[i],
    duration: clips[i].samples.length / clips[i].rate,
  }));
  // What the clip actually speaks — its writing system first (definitive for
  // non-Latin scripts), then the direction's ask, then the picked language.
  // Stamped on the asset so transcription later runs the right recognizer.
  const language =
    scriptSpokenLocale(lines.map((l) => l.text).join(" ")) ?? plan.language ?? opts.language;
  return { blob, offset, layout, ...(language ? { language } : {}) };
}

/** Save a rendered speech clip into the project's media folder as a voiceover
 * asset. Split from rendering so a preview can play the same clip without
 * committing it. */
export async function speechClipToAsset(
  projectId: string,
  blob: Blob,
  name?: string,
  language?: string
): Promise<MediaAsset> {
  const label = name?.trim() || "AI voice";
  const file = new File([blob], `${mediaSlug(label, "ai-voice")}.wav`, { type: "audio/wav" });
  const asset = await importFileToProject(projectId, file);
  if (!asset) throw new Error("Could not save the voiceover into the project.");
  asset.name = label;
  asset.origin = "voiceover";
  if (language) asset.language = language;
  // No Audio-tab badge here: this is the shared commit path (the panel, the
  // subtitles readout, the chat tools, the scene narration). Only the Audio
  // panel's own generator badges its tab — a chat- or run-made voiceover is
  // announced in the chat, never on the tab. The panel calls landed() itself.
  return asset;
}

/** Render the segments and save the result as a project voiceover asset —
 * render-then-commit in one call, for the surfaces that go straight to the
 * timeline. */
export async function synthesizeSpeech(
  projectId: string,
  segments: SpeechSegment[],
  opts: { voice: string; direction?: string; language?: string; name?: string }
): Promise<{ asset: MediaAsset; offset: number; layout: SpeechLayout[] }> {
  const { blob, offset, layout, language } = await renderSpeechClip(segments, opts);
  const asset = await speechClipToAsset(projectId, blob, opts.name, language);
  return { asset, offset, layout };
}
