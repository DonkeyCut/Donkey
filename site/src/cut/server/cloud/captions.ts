// Hosted caption AI: the cloud twin of the engine's Claude-CLI one-shots
// (server/ai/captions.ts, visualSubtitles.ts), same JSON contracts, run on
// Gemini and metered against the user's inference credits like transcribe.
//
//   POST ai/captions          {cues, style?, translateTo?} -> {texts}
//   POST ai/visual-subtitles  {frames, duration, locale?}  -> {cues}
import {
  creditErrorResponse,
  recordFailedInferenceUsage,
  recordInferenceUsage,
  requireInferenceCredits,
} from "@/lib/credits/inference";
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
import {
  BATCH_CONCURRENCY,
  BATCH_SIZE,
  BATCH_TIMEOUT_MS,
  languageName,
  rewritePrompt,
  STYLE_GUIDE,
  translatePrompt,
  visualSubtitlesPrompt,
  type CaptionInput,
} from "../ai/captionPrompts";
import { err } from "./util";

const PROVIDER = "gemini";
const MODEL = geminiModelRoles.chat;

const MAX_FRAMES = 24;
const MAX_BODY_BYTES = 4 * 1024 * 1024; // stay inside the hosted body limit
// One credit check covers the whole run, and the run is one model call per
// batch of cues, so the cue count is what bounds the spend behind that check.
// Transcripts run to about thirty cues a minute; this holds a three-hour lane.
const MAX_CUES = 6000;

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/** A terminal Response decided mid-flight (credit exhaustion, provider error)
 * that must reach the client as-is instead of a generic 500. */
class RespondWith extends Error {
  constructor(public readonly response: Response) {
    super("handled");
  }
}

/** One metered Gemini call: generate, record usage (success or failure), and
 * return the concatenated text parts. */
async function geminiOnce(
  userId: string,
  route: string,
  requestKind: string,
  parts: GeminiPart[]
): Promise<string> {
  const clientConfig = geminiClientConfig(process.env);
  if (!clientConfig.configured) throw new Error("Captions are not configured on this deployment.");
  let raw: unknown;
  try {
    const client = defaultGeminiClientFactory(clientConfig.options);
    raw = await client.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts }],
      // JSON mode without a schema — constrained decoding degrades output.
      config: { responseMimeType: "application/json" },
    });
  } catch (error) {
    await recordFailedInferenceUsage({
      clientId: null,
      errorCode: "provider_error",
      model: MODEL,
      provider: PROVIDER,
      requestKind,
      route,
      userId,
    });
    const credit = creditErrorResponse(error);
    if (credit) throw new RespondWith(credit);
    const mapped = geminiApiError("The caption model is unavailable.", error);
    throw new RespondWith(err(mapped.message, mapped.statusCode ?? 502));
  }
  const usage = (raw as { usageMetadata?: unknown }).usageMetadata;
  try {
    await recordInferenceUsage({
      clientId: null,
      model: MODEL,
      provider: PROVIDER,
      requestKind,
      route,
      status: "succeeded",
      usage: toJsonValue(usage ?? null),
      userId,
    });
  } catch (error) {
    const credit = creditErrorResponse(error);
    if (credit) throw new RespondWith(credit);
    throw error;
  }
  return geminiCandidateParts(geminiCandidates(raw as JsonValue)[0])
    .map((p) => stringValue(p.text) ?? "")
    .join("");
}

function parseJsonPayload(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const s = cleaned.indexOf("[");
    const e = cleaned.lastIndexOf("]");
    if (s < 0 || e <= s) return null;
    try {
      return JSON.parse(cleaned.slice(s, e + 1));
    } catch {
      return null;
    }
  }
}

function parseStringArray(raw: string, expected: number): string[] | null {
  const v = parseJsonPayload(raw);
  if (!Array.isArray(v) || v.length !== expected) return null;
  return v.map((x) => String(x));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

function timeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("timeout")), ms);
  });
}

export const captionsCloud = {
  /** Style rewrite or translation, one-to-one with the input cues. A failed
   * rewrite batch falls back to its originals; a failed translation batch gets
   * one retry, then the whole request errors — silently keeping the source
   * language would fill the track with wrong text. */
  async captions(userId: string, req: Request): Promise<Response> {
    const route = "/api/cut-cloud/ai/captions/";
    let cues: CaptionInput[] = [];
    let style = "clean";
    let translateTo = "";
    try {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return err("Too many cues.", 413);
      const body = JSON.parse(text) as {
        cues?: CaptionInput[];
        style?: string;
        translateTo?: string;
      };
      cues = Array.isArray(body.cues)
        ? body.cues.filter((c) => c && typeof c.text === "string")
        : [];
      if (cues.length > MAX_CUES) return err("Too many cues.", 413);
      if (typeof body.style === "string") style = body.style;
      if (typeof body.translateTo === "string") translateTo = body.translateTo;
    } catch {
      return err("Send JSON with cues.", 400);
    }
    if (cues.length === 0) return err("No cues to rewrite.", 400);

    const credits = await requireInferenceCredits({
      enforceModelPrice: true,
      model: MODEL,
      provider: PROVIDER,
      route,
      userId,
    });
    if (!credits.ok) return credits.response;

    const translating = translateTo.length > 0;
    const language = languageName(translateTo);
    const guide = STYLE_GUIDE[style] ?? STYLE_GUIDE.clean;

    try {
      const batches = chunk(cues, BATCH_SIZE);
      // Same shape as the engine: concurrency-limited batches, each raced
      // against the timeout; a failed rewrite batch falls back to its
      // originals, a failed translation batch gets one retry then errors.
      // Credit-exhaustion and provider rejections (RespondWith) always abort —
      // silently swallowing those would hide a real, actionable failure.
      const texts = await mapLimit(batches, BATCH_CONCURRENCY, async (batch, index) => {
        const prompt = translating
          ? translatePrompt(batch, language)
          : rewritePrompt(batch, guide, index === 0);
        const run = async () => {
          const raw = await Promise.race([
            geminiOnce(userId, route, "captions", [{ text: prompt }]),
            timeout(BATCH_TIMEOUT_MS),
          ]);
          const arr = parseStringArray(raw, batch.length);
          if (!arr) throw new Error("The reply came back malformed.");
          return arr;
        };
        try {
          return await run();
        } catch (e) {
          if (e instanceof RespondWith) throw e;
          if (!translating) return batch.map((c) => c.text);
          return await run(); // one retry — timeouts and malformed replies are transient
        }
      });
      const flat = texts.flat().map((s, i) => (s && s.trim() ? s.trim() : cues[i].text));
      return Response.json({ texts: flat });
    } catch (e) {
      if (e instanceof RespondWith) return e.response;
      return err(e instanceof Error ? e.message : "Could not write captions.", 500);
    }
  },

  /** Subtitle cues written from sampled frames — for cuts with no usable
   * audio. Frames arrive as data-URL jpegs from the client's canvas. */
  async visualSubtitles(userId: string, req: Request): Promise<Response> {
    const route = "/api/cut-cloud/ai/visual-subtitles/";
    let frames: { at: number; image: string }[] = [];
    let duration = 0;
    let locale = "en-US";
    try {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return err("Too many frames.", 413);
      const body = JSON.parse(text) as {
        frames?: { at?: number; image?: string }[];
        duration?: number;
        locale?: string;
      };
      frames = Array.isArray(body.frames)
        ? body.frames.filter(
            (f): f is { at: number; image: string } =>
              !!f && typeof f.at === "number" && typeof f.image === "string"
          )
        : [];
      duration = typeof body.duration === "number" ? body.duration : 0;
      if (typeof body.locale === "string" && body.locale) locale = body.locale;
    } catch {
      return err("Send JSON with frames and duration.", 400);
    }
    if (frames.length === 0 || duration <= 0) return err("frames and duration are required.", 400);

    const parts: GeminiPart[] = [];
    for (const f of frames.slice(0, MAX_FRAMES)) {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(f.image);
      if (!m) continue;
      parts.push({ text: `Frame at ${Math.max(0, f.at).toFixed(1)}s:` });
      parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    }
    if (parts.length === 0) return err("No frames to caption.", 400);
    parts.unshift({ text: visualSubtitlesPrompt(duration, locale) });

    const credits = await requireInferenceCredits({
      enforceModelPrice: true,
      model: MODEL,
      provider: PROVIDER,
      route,
      userId,
    });
    if (!credits.ok) return credits.response;

    try {
      const raw = await geminiOnce(userId, route, "visual_subtitles", parts);
      const parsed = parseJsonPayload(raw);
      if (!Array.isArray(parsed)) {
        return err("The caption model returned an unreadable response — try again.", 502);
      }
      const cues = parsed
        .filter(
          (c): c is { start: number; end: number; text: string } =>
            !!c &&
            typeof c === "object" &&
            typeof (c as { start?: unknown }).start === "number" &&
            typeof (c as { end?: unknown }).end === "number" &&
            typeof (c as { text?: unknown }).text === "string"
        )
        .map((c) => ({
          start: Math.max(0, Math.min(c.start, duration)),
          end: Math.max(0, Math.min(c.end, duration)),
          text: c.text.trim(),
        }))
        .filter((c) => c.text && c.end > c.start)
        .sort((a, b) => a.start - b.start);
      return Response.json({ cues });
    } catch (e) {
      if (e instanceof RespondWith) return e.response;
      return err(e instanceof Error ? e.message : "Could not caption the visuals.", 500);
    }
  },
};
