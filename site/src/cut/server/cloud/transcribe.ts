// Hosted transcription: one short 16 kHz mono WAV chunk in, cue-level
// timestamps out. The client renders the timeline's audible mix, chunks it
// short enough to bound the model's timing drift, and stitches the results
// (lib/cloudTranscribe.ts); this route only turns one chunk of speech into
// cues with Gemini. Each account's allowance of chunks is included (Pro per
// billing period, free per month — see withinFreeAllowance); chunks past
// that meter against the user's inference credits like every /api/inference
// route.
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
import { toJsonValue } from "@/lib/inference/json";
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
// The registry's chat flash: multimodal, takes inline audio, priced in
// provider-pricing.ts. No dedicated STT role exists, so speech-to-text rides
// the chat model.
const MODEL = geminiModelRoles.chat;

// Each account's first chunks in its allowance window are on the house, so
// transcripts fill in for every project — the background sweep included —
// before any charge appears. A chunk is at most 20 seconds of speech-bearing
// audio (silent chunks never reach this route), at about $0.004 provider
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

interface WireCue {
  start: number;
  end: number;
  text: string;
}

const transcribePrompt = (locale: string) =>
  [
    "Transcribe the speech in this audio verbatim, in the language actually spoken" +
      (locale ? ` (expected: ${locale})` : "") +
      ".",
    'Return ONLY a JSON array of cues: [{"start": <seconds>, "end": <seconds>, "text": "<words>"}].',
    "Times are seconds from the start of this audio.",
    "Keep cues short — at most 7 words each — and in spoken order.",
    "Return [] when there is no speech.",
  ].join(" ");

/** The model's cue array, parsed defensively: code fences stripped, the
 * outermost [...] recovered from surrounding prose, entries validated and
 * clamped to the chunk. Null when no JSON array can be read at all. */
function parseCues(raw: string, maxEnd: number): WireCue[] | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const s = cleaned.indexOf("[");
    const e = cleaned.lastIndexOf("]");
    if (s < 0 || e <= s) return null;
    try {
      parsed = JSON.parse(cleaned.slice(s, e + 1));
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;
  const cues: WireCue[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { start, end, text } = item as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number" || typeof text !== "string") continue;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const s = Math.max(0, Math.min(start, maxEnd));
    const e = Math.max(0, Math.min(end, maxEnd));
    const t = text.trim();
    if (!t || e <= s) continue;
    cues.push({ start: s, end: e, text: t });
  }
  return cues.sort((a, b) => a.start - b.start);
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
      raw = await client.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "audio/wav", data: wavBase64 } },
              { text: transcribePrompt(locale) },
            ],
          },
        ],
        // JSON mode without a schema — constrained decoding degrades output.
        config: { responseMimeType: "application/json", temperature: 0 },
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

    const text = geminiCandidateParts(geminiCandidates(raw as JsonValue)[0])
      .map((p) => stringValue(p.text) ?? "")
      .join("");
    const cues = parseCues(text, audioSeconds);
    if (cues === null) {
      return err("The transcription model returned an unreadable response — try again.", 502);
    }
    return Response.json({ cues });
  },
};
