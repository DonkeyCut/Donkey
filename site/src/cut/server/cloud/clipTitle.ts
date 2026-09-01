// Hosted clip titling: a short name for one recording, read off what is said
// in it and what is on screen.
//
//   POST library/title  {assetId, audio?, frame?} -> {title}
//
// The client sends the opening speech as a 16 kHz mono WAV and one still,
// both pulled from media it is already showing (lib/clipTitle.ts). The title
// is written onto the asset's meta, so the model runs once per clip and every
// device reads the same name afterwards. Titles are on the house — a phone
// recording arrives named after its clock, and the name that replaces it is
// not something anyone asked to buy.
import {
  creditErrorResponse,
  recordFailedInferenceUsage,
  recordInferenceUsage,
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
import { prisma } from "@/lib/prisma";
import { cutLimitsFor } from "./limits";
import { err } from "./util";

const ROUTE = "/api/cut-cloud/library/title";
const PROVIDER = "gemini";
// A four-word name off half a minute of speech and one frame: the lightest
// model in the registry answers this well and costs a fraction of a cent.
const MODEL = geminiModelRoles.fastDecision;
const REQUEST_KIND = "clip_title";

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const FRAME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/** Long enough that a hovering card can hand the whole line over, short enough
 * that the tile reads at a glance. */
const MAX_TITLE_CHARS = 60;
/** Whether one more title fits today's allowance — titles are on the house,
 * so the tier sets a daily ceiling, and past it the tile shows the file name
 * until tomorrow. Counted from the route's own usage events so the ledger is
 * the tracker. */
async function withinTitleAllowance(userId: string): Promise<boolean> {
  const { titlesPerDay } = await cutLimitsFor(userId);
  if (titlesPerDay === null) return true;
  const used = await prisma.inferenceUsageEvent.count({
    where: {
      userId,
      route: ROUTE,
      status: "succeeded",
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });
  return used < titlesPerDay;
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

interface AssetMetaWithTitle {
  name?: string;
  title?: string;
  duration?: number;
}

const prompt = (heard: boolean, seen: boolean, duration: number) =>
  [
    "Name this video clip the way its owner would in a camera roll.",
    heard
      ? "The audio is the opening of the clip; take the subject from what is actually said."
      : "",
    seen ? "The image is a frame from the clip." : "",
    duration > 0 ? `The clip runs ${Math.round(duration)} seconds.` : "",
    "Write at most five words, in title case, naming what this clip is about.",
    "Two clips shot in the same room must still read apart, so name the subject rather than the setting.",
    'Never use a date, a time, or the words "video", "clip", or "recording".',
    'Return ONLY JSON: {"title": "<the title>"}',
  ]
    .filter(Boolean)
    .join(" ");

/** The model's object, parsed defensively: code fences stripped, the outermost
 * {...} recovered from surrounding prose. Null when no title can be read. */
function parseTitle(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const s = cleaned.indexOf("{");
    const e = cleaned.lastIndexOf("}");
    if (s < 0 || e <= s) return null;
    try {
      parsed = JSON.parse(cleaned.slice(s, e + 1));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const title = (parsed as Record<string, unknown>).title;
  return typeof title === "string" ? clean(title) : null;
}

/** One line, no wrapping quotes, no trailing punctuation, cut at a word
 * boundary when the model runs long. */
function clean(raw: string): string | null {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  s = s.replace(/[.,;:!?]+$/, "").trim();
  if (!s) return null;
  if (s.length > MAX_TITLE_CHARS) {
    const cut = s.slice(0, MAX_TITLE_CHARS);
    const space = cut.lastIndexOf(" ");
    s = (space > 20 ? cut.slice(0, space) : cut).trim();
  }
  return s || null;
}

export const clipTitleCloud = {
  async title(userId: string, req: Request): Promise<Response> {
    let assetId = "";
    let audio: File | null = null;
    let frame: File | null = null;
    try {
      const form = await req.formData();
      const id = form.get("assetId");
      assetId = typeof id === "string" ? id.trim() : "";
      const a = form.get("audio");
      audio = a instanceof File && a.size > 0 ? a : null;
      const f = form.get("frame");
      frame = f instanceof File && f.size > 0 ? f : null;
    } catch {
      return err("Send multipart form data.", 400);
    }
    if (!assetId) return err("assetId is required.", 400);
    if (audio && audio.size > MAX_AUDIO_BYTES) return err("Audio too large.", 413);
    if (frame && frame.size > MAX_FRAME_BYTES) return err("Frame too large.", 413);
    if (frame && !FRAME_TYPES.has(frame.type)) frame = null;
    if (!audio && !frame) return err("Send audio, a frame, or both.", 400);

    const row = await prisma.cutLibraryAsset.findFirst({
      where: { id: assetId, userId, deletedAt: null },
    });
    if (!row) return err("Asset not found.", 404);
    const meta = (row.meta ?? {}) as AssetMetaWithTitle;
    // A clip is titled once. A second caller — another tab reading the same
    // shelf, a listing that arrived before the write — gets the title back
    // without spending a model call on it.
    if (meta.title) return Response.json({ title: meta.title });
    if (!(await withinTitleAllowance(userId))) return err("Titling is paused for today.", 429);

    const clientConfig = geminiClientConfig(process.env);
    if (!clientConfig.configured) return err("Titling is not configured on this deployment.", 500);

    const parts: GeminiPart[] = [];
    if (audio) {
      parts.push({
        inlineData: {
          mimeType: "audio/wav",
          data: Buffer.from(await audio.arrayBuffer()).toString("base64"),
        },
      });
    }
    if (frame) {
      parts.push({
        inlineData: {
          mimeType: frame.type,
          data: Buffer.from(await frame.arrayBuffer()).toString("base64"),
        },
      });
    }
    parts.push({ text: prompt(!!audio, !!frame, meta.duration ?? 0) });

    let raw: unknown;
    try {
      const client = defaultGeminiClientFactory(clientConfig.options);
      raw = await client.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts }],
        // JSON mode without a schema — constrained decoding degrades output.
        config: { responseMimeType: "application/json", temperature: 0.4 },
      });
    } catch (error) {
      await recordFailedInferenceUsage({
        billingMode: "included",
        clientId: null,
        errorCode: "provider_error",
        model: MODEL,
        provider: PROVIDER,
        requestKind: REQUEST_KIND,
        route: ROUTE,
        userId,
      });
      const credit = creditErrorResponse(error);
      if (credit) return credit;
      const mapped = geminiApiError("The titling model is unavailable.", error);
      return err(mapped.message, mapped.statusCode ?? 502);
    }

    const usage = (raw as { usageMetadata?: unknown }).usageMetadata;
    try {
      await recordInferenceUsage({
        billingMode: "included",
        clientId: null,
        model: MODEL,
        provider: PROVIDER,
        requestKind: REQUEST_KIND,
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
    const title = parseTitle(text);
    if (!title) return err("The titling model returned an unreadable response.", 502);

    // Written under the row's own meta so the name outlives this tab and
    // reaches the phone's next listing.
    await prisma.cutLibraryAsset.update({
      where: { id: row.id },
      data: { meta: { ...(meta as Record<string, unknown>), title } },
    });
    return Response.json({ title });
  },
};
