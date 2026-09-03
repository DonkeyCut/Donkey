// Hosted transcription: one short 16 kHz mono WAV chunk in, word-timed cues
// out. The client renders the timeline's audible mix, chunks it, and stitches
// the results (lib/cloudTranscribe.ts); this route only turns one chunk of
// speech into cues with the Gemini speech model, which returns every word
// with its own start and end. Each account's allowance of chunks is included
// (Pro per billing period, free per month — see withinFreeAllowance); chunks
// past that meter against the user's inference credits like every
// /api/inference route.
import {
  creditErrorResponse,
  recordFailedInferenceUsage,
  recordInferenceUsage,
  requireInferenceCredits,
} from "@/lib/credits/inference";
import { getActiveProSubscription } from "@/lib/billing/pro-subscription";
import { prisma } from "@/lib/prisma";
import {
  defaultGeminiClientFactory,
  geminiApiError,
  geminiCandidateParts,
  geminiCandidates,
  geminiClientConfig,
  stringValue,
} from "@/lib/inference/adapters/gemini-client";
import { geminiModelRoles } from "@/lib/inference/gemini-models";
import { isJsonObject, toJsonValue } from "@/lib/inference/json";
import type { JsonValue } from "@/lib/inference/providers";
import { err } from "./util";

// The client sends 16 kHz 16-bit mono PCM in chunks of at most 20 seconds; the
// allowance below counts chunks, so the chunk itself is held to that length
// (with a little room), or an oversized chunk would be minutes on the house.
const PCM_BYTES_PER_SECOND = 32_000;
const MAX_CHUNK_SECONDS = 30;
const MAX_AUDIO_BYTES = 44 + MAX_CHUNK_SECONDS * PCM_BYTES_PER_SECOND;
const ROUTE = "/api/cut-cloud/transcribe/";
const PROVIDER = "gemini";
// The registry's speech model: audio in, the words with their timings out,
// priced in provider-pricing.ts.
const MODEL = geminiModelRoles.transcription;

// Each account's first chunks in its allowance window are on the house, so
// transcripts fill in for every project — the background sweep included —
// before any charge appears. A chunk is at most 20 seconds of speech-bearing
// audio (silent chunks never reach this route), at about $0.001 provider
// cost each. Pro includes 2 hours per billing period, aligned to the
// subscription's own cycle; a free account gets 30 minutes per UTC calendar
// month. Past the allowance, chunks bill the credit balance as usual; a
// `freeOnly` caller is turned away instead.
//
// The background sweep (`freeOnly`) may take at most half the allowance: it
// transcribes what nobody asked for, so the user's own caption runs always
// find at least the other half included. Sweep chunks record under their own
// request kind, which is how the halves are told apart.
const PRO_FREE_CHUNKS = 360; // 2 hours at 20s per chunk
const FREE_CHUNKS = 90; // 30 minutes
const USER_KIND = "transcribe";
const SWEEP_KIND = "transcribe_sweep";
export const freeTranscriptionExhausted = "free_transcription_exhausted";

/** Whether this chunk fits the caller's remaining allowance. Used chunks are
 * counted from the route's own "included" usage events since the window
 * opened, so the ledger is the tracker and no separate counter can drift
 * from it. Concurrent chunks can each pass the check before any of them
 * records, so the allowance can overshoot by the posts-in-flight few —
 * bounded and cheap, like the credit preflight's own concurrency window. */
async function withinFreeAllowance(userId: string, sweep: boolean): Promise<boolean> {
  const pro = await getActiveProSubscription(userId);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const windowStart = pro?.currentPeriodStart ?? monthStart;
  const used = await prisma.inferenceUsageEvent.groupBy({
    by: ["requestKind"],
    _count: { _all: true },
    where: {
      userId,
      route: ROUTE,
      billingStatus: "included",
      status: "succeeded",
      createdAt: { gte: windowStart },
    },
  });
  const total = used.reduce((n, u) => n + u._count._all, 0);
  const cap = pro ? PRO_FREE_CHUNKS : FREE_CHUNKS;
  if (total >= cap) return false;
  if (!sweep) return true;
  const sweepUsed = used.find((u) => u.requestKind === SWEEP_KIND)?._count._all ?? 0;
  return sweepUsed < Math.floor(cap / 2);
}

interface WireWord {
  t0: number;
  t1: number;
  w: string;
}

interface WireCue {
  start: number;
  end: number;
  text: string;
  words: WireWord[];
}

// The speech model detects the language itself; a locale the caller expects
// rides along as a hint when it is one the model lists. Bare languages map to
// the model's default region for that language, and a language the model does
// not list sends no hint (auto-detect).
const TRANSCRIBE_LANGUAGE_CODES = new Set([
  "af-ZA", "am-ET", "ar-EG", "as-IN", "az-AZ", "be-BY", "bg-BG", "bn-BD", "bn-IN",
  "bs-BA", "ca-ES", "ceb", "cmn-Hans-CN", "cs-CZ", "da-DK", "de-DE", "el-GR",
  "en-AU", "en-GB", "en-IN", "en-US", "es-419", "es-ES", "es-US", "et-EE", "fa-IR",
  "fi-FI", "fil-PH", "fr-CA", "fr-FR", "gl-ES", "gu-IN", "ha-NG", "he-IL", "hi-IN",
  "hr-HR", "hu-HU", "hy-AM", "id-ID", "is-IS", "it-IT", "ja-JP", "jv-ID", "ka-GE",
  "kea-CV", "kk-KZ", "km-KH", "kn-IN", "ko-KR", "ky-KG", "ln-CD", "lt-LT", "lv-LV",
  "mk-MK", "ml-IN", "mn-MN", "mr-IN", "ms-MY", "mt-MT", "my-MM", "nb-NO", "ne-NP",
  "nl-NL", "or-IN", "pa-Guru-IN", "pa-IN", "pl-PL", "pt-BR", "pt-PT", "ro-RO",
  "ru-RU", "rup-BG", "sd-Arab-IN", "sk-SK", "sl-SI", "sr-RS", "sv-SE", "sw-KE",
  "te-IN", "tg-TJ", "th-TH", "tr-TR", "uk-UA", "uz-UZ", "vi-VN", "yue-Hant-HK",
]);
const TRANSCRIBE_LANGUAGE_DEFAULTS: Record<string, string> = {
  af: "af-ZA", am: "am-ET", ar: "ar-EG", as: "as-IN", az: "az-AZ", be: "be-BY",
  bg: "bg-BG", bn: "bn-IN", bs: "bs-BA", ca: "ca-ES", ceb: "ceb", cmn: "cmn-Hans-CN",
  cs: "cs-CZ", da: "da-DK", de: "de-DE", el: "el-GR", en: "en-US", es: "es-ES",
  et: "et-EE", fa: "fa-IR", fi: "fi-FI", fil: "fil-PH", fr: "fr-FR", gl: "gl-ES",
  gu: "gu-IN", ha: "ha-NG", he: "he-IL", hi: "hi-IN", hr: "hr-HR", hu: "hu-HU",
  hy: "hy-AM", id: "id-ID", is: "is-IS", it: "it-IT", ja: "ja-JP", jv: "jv-ID",
  ka: "ka-GE", kk: "kk-KZ", km: "km-KH", kn: "kn-IN", ko: "ko-KR", ky: "ky-KG",
  ln: "ln-CD", lt: "lt-LT", lv: "lv-LV", mk: "mk-MK", ml: "ml-IN", mn: "mn-MN",
  mr: "mr-IN", ms: "ms-MY", mt: "mt-MT", my: "my-MM", nb: "nb-NO", ne: "ne-NP",
  nl: "nl-NL", no: "nb-NO", or: "or-IN", pa: "pa-IN", pl: "pl-PL", pt: "pt-BR",
  ro: "ro-RO", ru: "ru-RU", sd: "sd-Arab-IN", sk: "sk-SK", sl: "sl-SI", sr: "sr-RS",
  sv: "sv-SE", sw: "sw-KE", te: "te-IN", tg: "tg-TJ", th: "th-TH", tr: "tr-TR",
  uk: "uk-UA", uz: "uz-UZ", vi: "vi-VN", yue: "yue-Hant-HK", zh: "cmn-Hans-CN",
};

/** The model's language code for a caller locale, or undefined to let the
 * model detect the language. */
export function transcribeLanguageCode(locale: string): string | undefined {
  const parts = locale.trim().split(/[-_]/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const lang = parts[0].toLowerCase();
  if (parts.length > 1) {
    const region = parts[parts.length - 1];
    const exact = `${lang}-${region.length === 2 ? region.toUpperCase() : region}`;
    if (TRANSCRIBE_LANGUAGE_CODES.has(exact)) return exact;
  }
  return TRANSCRIBE_LANGUAGE_DEFAULTS[lang];
}

/** "1.250s" → 1.25; null for anything else. */
function offsetSeconds(value: JsonValue | undefined): number | null {
  const text = stringValue(value);
  if (!text) return null;
  const n = Number.parseFloat(text.replace(/s$/i, ""));
  return Number.isFinite(n) ? n : null;
}

/** Every timed word the response carries, in spoken order, clamped to the
 * chunk. Null when the response holds text but no timed words — the model
 * answered in a shape this route cannot time. */
function readWords(raw: JsonValue, maxEnd: number): WireWord[] | null {
  const parts = geminiCandidateParts(geminiCandidates(raw)[0]);
  const words: WireWord[] = [];
  let sawText = false;
  for (const part of parts) {
    const transcription = part.audioTranscription;
    if (!isJsonObject(transcription)) {
      if (stringValue(part.text)?.trim()) sawText = true;
      continue;
    }
    if (stringValue(transcription.text)?.trim()) sawText = true;
    const list = transcription.words;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isJsonObject(item)) continue;
      const w = stringValue(item.word)?.trim();
      const t0 = offsetSeconds(item.startOffset);
      const t1 = offsetSeconds(item.endOffset);
      if (!w || t0 === null || t1 === null) continue;
      const s = Math.max(0, Math.min(t0, maxEnd));
      const e = Math.max(s, Math.min(t1, maxEnd));
      words.push({ t0: s, t1: e, w });
    }
  }
  if (words.length === 0 && sawText) return null;
  return words.sort((a, b) => a.t0 - b.t0);
}

// Words become short captions: at most this many per cue, a new cue on a
// pause longer than this, and a new cue after a sentence ends.
const CUE_MAX_WORDS = 7;
const CUE_BREAK_GAP_SECONDS = 0.6;

/** Timed words grouped into cues the caption track can show as they are. */
export function groupWordsIntoCues(words: WireWord[]): WireCue[] {
  const cues: WireCue[] = [];
  let current: WireWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    cues.push({
      start: current[0].t0,
      end: current[current.length - 1].t1,
      text: current.map((w) => w.w).join(" "),
      words: current,
    });
    current = [];
  };
  for (const word of words) {
    const prev = current[current.length - 1];
    if (
      prev &&
      (current.length >= CUE_MAX_WORDS ||
        word.t0 - prev.t1 > CUE_BREAK_GAP_SECONDS ||
        /[.!?]["'”’)]*$/.test(prev.w))
    ) {
      flush();
    }
    current.push(word);
  }
  flush();
  return cues;
}

export const transcribeCloud = {
  async transcribe(userId: string, req: Request): Promise<Response> {
    let audio: File | null = null;
    let locale = "";
    let freeOnly = false;
    try {
      const form = await req.formData();
      const a = form.get("audio");
      audio = a instanceof File ? a : null;
      const l = form.get("locale");
      locale = typeof l === "string" ? l.trim() : "";
      freeOnly = form.get("freeOnly") === "1";
    } catch {
      return err("Send multipart form data with an audio file.", 400);
    }
    if (!audio || audio.size === 0) return err("Missing audio.", 400);
    if (audio.size > MAX_AUDIO_BYTES) return err("Audio chunk too large.", 413);

    const clientConfig = geminiClientConfig(process.env);
    if (!clientConfig.configured) {
      return err("Transcription is not configured on this deployment.", 500);
    }

    // Inside the allowance the chunk is on the house — no balance check, so a
    // zero-balance account still gets its transcripts. Past it, a background
    // (`freeOnly`) caller stops here with nothing run and nothing spent; a
    // user-initiated call clears the usual credit preflight and bills.
    const included = await withinFreeAllowance(userId, freeOnly);
    if (!included) {
      if (freeOnly) {
        return Response.json(
          { error: freeTranscriptionExhausted, message: "The free transcription allowance is used up." },
          { status: 402 },
        );
      }
      const credits = await requireInferenceCredits({
        enforceModelPrice: true,
        model: MODEL,
        provider: PROVIDER,
        route: ROUTE,
        userId,
      });
      if (!credits.ok) return credits.response;
    }

    // Seconds of 16 kHz s16 mono after the 44-byte RIFF header — the clamp
    // ceiling for cue times the model may overshoot.
    const audioSeconds = Math.max(1, (audio.size - 44) / PCM_BYTES_PER_SECOND);
    const wavBase64 = Buffer.from(await audio.arrayBuffer()).toString("base64");

    let raw: unknown;
    try {
      const client = defaultGeminiClientFactory(clientConfig.options);
      const languageCode = transcribeLanguageCode(locale);
      raw = await client.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: "user",
            parts: [{ inlineData: { mimeType: "audio/wav", data: wavBase64 } }],
          },
        ],
        // The speech model takes no prompt, system instruction, or output
        // schema; the transcription config is the whole request.
        config: {
          audioTranscriptionConfig: {
            wordTimestamp: true,
            ...(languageCode ? { languageCodes: [languageCode] } : {}),
          },
        },
      });
    } catch (error) {
      await recordFailedInferenceUsage({
        billingMode: included ? "included" : "credits",
        clientId: null,
        errorCode: "provider_error",
        model: MODEL,
        provider: PROVIDER,
        requestKind: freeOnly ? SWEEP_KIND : USER_KIND,
        route: ROUTE,
        userId,
      });
      const credit = creditErrorResponse(error);
      if (credit) return credit;
      const mapped = geminiApiError("Transcription failed.", error);
      return err(mapped.message, mapped.statusCode ?? 502);
    }

    // The call succeeded and spent tokens; record and charge before judging
    // the payload, exactly like the /api/inference routes.
    const usage = (raw as { usageMetadata?: unknown }).usageMetadata;
    try {
      await recordInferenceUsage({
        billingMode: included ? "included" : "credits",
        clientId: null,
        model: MODEL,
        provider: PROVIDER,
        requestKind: freeOnly ? SWEEP_KIND : USER_KIND,
        route: ROUTE,
        status: "succeeded",
        usage: toJsonValue(usage ?? null),
        userId,
      });
    } catch (error) {
      const credit = creditErrorResponse(error);
      if (credit) return credit;
      throw error;
    }

    const words = readWords(raw as JsonValue, audioSeconds);
    if (words === null) {
      return err("The transcription model returned no word timings — try again.", 502);
    }
    return Response.json({ cues: groupWordsIntoCues(words) });
  },
};
