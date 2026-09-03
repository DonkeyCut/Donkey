"use client";

/**
 * The judgment roles — script, breakdown, style — as one-shot structured LLM
 * calls through Donkey's hosted Gemini (the same `/api/inference/responses`
 * json_object path prompt composition already uses). Each returns plain JSON we
 * validate in code; nothing here enforces a provider-side schema, matching how
 * the planner runs.
 *
 * The one contract that ties the three together: character and location ids.
 * The script (or breakdown) assigns stable ids — char:1, loc:1, … — and every
 * shot carries them. The style role is handed those exact ids and returns one
 * asset per id, so the reference images it designs tie back to the shots by
 * construction, not by hoping two independent calls agree.
 */

import { geminiModelRoleNames } from "@/lib/inference/gemini-models";
import { hostedPost } from "../../hosted";
import { NO_CREDITS_MESSAGE } from "../../credits";
import { secToFrame, type RawShot } from "../coverage";
import { wordsInRange, type BreakdownRole, type ScriptRole, type StyleRole } from "../capabilities";
import { refImageParts, type InlineImagePart } from "./refImages";
import type { ScriptBeat, ScriptPlan, TranscriptWord, VideoAsset } from "../types";

// ── the shared call ─────────────────────────────────────────────────────────

/** One structured JSON completion. `parse` returns null for unusable output.
 * Transient failures — rate limits, upstream 5xx, network blips, an
 * unparseable sample — retry before the error escapes: a plan step failing on
 * one blip poisons everything downstream of it. These are background steps,
 * so the envelope is wide enough (~30s) to ride out a real overload burst,
 * which a couple of sub-second retries cannot. Sign-in and credit errors
 * throw immediately; retrying can't fix them. */
const LLM_RETRY_DELAYS_MS = [0, 2_000, 8_000, 20_000];

async function llmJson<T>(
  instructions: string,
  userText: string,
  parse: (o: Record<string, unknown>) => T | null,
  images: InlineImagePart[] = []
): Promise<T> {
  let lastError = new Error("The planning model is unavailable — try again.");
  for (const delay of LLM_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    let res: Response;
    try {
      res = await hostedPost("/api/inference/responses", {
        donkeyProvider: "gemini",
        model: geminiModelRoleNames.chat,
        instructions,
        response_format: { type: "json_object" },
        input: [
          {
            role: "user",
            content: [
              { text: userText },
              ...images.map((i) => ({ type: "input_image", dataBase64: i.data, mimeType: i.mimeType })),
            ],
          },
        ],
      });
    } catch {
      continue; // network blip — retry
    }
    if (!res.ok) {
      if (res.status === 402) throw new Error(NO_CREDITS_MESSAGE);
      if (res.status === 401) throw new Error("Sign in to Donkey to generate a video.");
      const reason = await providerReason(res);
      lastError = new Error(reason ?? "The planning model is unavailable — try again.");
      // Any other 4xx is deterministic — the same request fails the same way —
      // so surface the reason now instead of burning the retry envelope on it.
      if (res.status < 500 && res.status !== 408 && res.status !== 429) throw lastError;
      continue;
    }
    const body = (await res.json()) as { output_text?: string };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.output_text ?? "") as Record<string, unknown>;
    } catch {
      lastError = new Error("The planning model returned unreadable output.");
      continue;
    }
    const out = parse(parsed);
    if (out === null) {
      lastError = new Error("The planning model returned an unusable plan.");
      continue;
    }
    return out;
  }
  throw lastError;
}

/** The provider's human reason from an error body, when one rode along. */
async function providerReason(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { message?: string; details?: { message?: string } };
    const msg = body.details?.message || body.message;
    return typeof msg === "string" && msg.trim() ? msg.trim() : null;
  } catch {
    return null;
  }
}

// ── coercion helpers ────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const idList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
const distinct = (xs: string[]): string[] => Array.from(new Set(xs.filter(Boolean)));

// ── script ──────────────────────────────────────────────────────────────────

const SCRIPT_INSTRUCTIONS = `You are a short-video writer. Turn the brief into a spoken video plan.
Reply with JSON only:
{"logline": string, "style": string, "beats": [
  {"dialogue": string, "action": string, "characters": ["char:1"], "location": "loc:1", "framing": string, "intent": string, "approxSeconds": number}
]}
Rules:
- dialogue is the narration/spoken line for that beat (one or two sentences), action is what is shown on screen.
- logline is one sentence naming the whole video's story — the throughline every beat serves. intent is that beat's job in the story in a few words ("establish the world", "the turn", "the payoff", "raise the stakes"), so a shot rendered on its own still knows what it is FOR.
- Shape the beats as a story, not a list: open by establishing the world, turn on a small surprise or decision, and end on a payoff image that resolves it. Every beat must move the story from the one before it — never a repeat or a generic filler image any beat could use.
- framing is real camera language fit to the genre, varied beat to beat — wide establishing, close-up, insert of a telling detail (a sign, hands, an object), POV, follow shot, over-the-shoulder, aerial, macro, low angle, whatever the story calls for. Never the same framing twice in a row, and never treat this list as a quota.
- action carries continuity: name the wardrobe items and props the story repeats (the book, the earbuds, the bag) in every beat where they appear, so shots rendered independently still match.
- A shot cannot be trusted to render readable text: no signs, labels, charts, graphic overlays, or lettering beyond a single short word — information the viewer must read goes in the dialogue instead.
- Assign each recurring character a stable id "char:1", "char:2", … and each place a stable id "loc:1", "loc:2", …; every beat lists the ids it uses. A beat with no character uses []. A character introduced late (the reveal) is still a stable id from its first beat.
- Keep the whole thing near the requested length; each beat is about 4–8 seconds of narration.
- style is a short reusable look for the whole video (medium, lighting, palette, mood), described by its visual traits — never a real brand, franchise, show, or artist name, even one the brief uses (a generator rejects trademarked names).`;

/** One raw beat object → a validated ScriptBeat. Shared by the first draft and
 * the coverage revision so both coerce identically (intent included). */
function toBeat(b: unknown): ScriptBeat {
  const beat = (b ?? {}) as Record<string, unknown>;
  return {
    dialogue: str(beat.dialogue),
    action: str(beat.action),
    characters: idList(beat.characters),
    location: str(beat.location) || "loc:1",
    framing: str(beat.framing) || "medium shot",
    ...(str(beat.intent) ? { intent: str(beat.intent) } : {}),
    approxSeconds: Math.max(2, Math.min(8, num(beat.approxSeconds, 6))),
  };
}

function parseScript(o: Record<string, unknown>): ScriptPlan | null {
  const rawBeats = Array.isArray(o.beats) ? o.beats : [];
  const beats: ScriptBeat[] = rawBeats.map(toBeat).filter((b) => b.dialogue || b.action);
  if (beats.length === 0) return null;
  return {
    logline: str(o.logline),
    beats,
    style: typeof o.style === "string" && o.style.trim() ? o.style.trim() : undefined,
  };
}

// ── brief-coverage self-check ────────────────────────────────────────────────

const COVERAGE_INSTRUCTIONS = `You are a script editor checking a drafted shot plan against its brief before it goes into production.
Reply with JSON only:
{"missing": [string], "beats": [
  {"dialogue": string, "action": string, "characters": ["char:1"], "location": "loc:1", "framing": string, "intent": string, "approxSeconds": number}
]}
Rules:
- missing lists every concrete thing the brief explicitly asks to see or say that the drafted beats do not — a named subject, object, action, place, or event. Judge only what the brief actually calls for; invent no new requirements.
- If nothing is missing, return {"missing": [], "beats": []} and change nothing.
- Otherwise return a COMPLETE revised beats array: keep the beats that work, and add or repair beats so every missing element lands on screen or in the narration. Stay near the same number of beats and total length, reuse the same char:/loc: ids, and keep the story shape (establish, turn, payoff) with each beat advancing the one before it.
- Every rule the draft followed still holds: dialogue is the spoken line, action is what the camera sees, intent is the beat's job in the story, framing is real camera language varied beat to beat, no on-screen text, and no real brand, franchise, show, or artist names.`;

/** Second pass: verify the draft covers everything the brief asks for, and
 * revise it in place when it doesn't. Best-effort — a failure (or an
 * unparseable revision) keeps the draft, so coverage never blocks a run that
 * already has a usable script. Skipped when there is no brief to check against. */
async function reviseForCoverage(brief: string, plan: ScriptPlan): Promise<ScriptPlan> {
  const drafted = plan.beats
    .map((b, i) => `${i + 1}. [${b.intent || "—"}] ${b.action}${b.dialogue ? ` — "${b.dialogue}"` : ""}`)
    .join("\n");
  const user = `Brief: ${brief}

Drafted beats:
${drafted}

List anything the brief asks for that these beats miss. If nothing is missing, return empty arrays; otherwise return a full revised beats array that covers it.`;
  try {
    const revised = await llmJson(COVERAGE_INSTRUCTIONS, user, (o) => {
      const rawBeats = Array.isArray(o.beats) ? o.beats : [];
      const beats = rawBeats.map(toBeat).filter((b) => b.dialogue || b.action);
      // Never null: an empty array is the valid "nothing missing" answer, and
      // llmJson would otherwise retry a correct verdict as unusable.
      return { beats } as { beats: ScriptBeat[] };
    });
    return revised.beats.length ? { ...plan, beats: revised.beats } : plan;
  } catch {
    return plan; // the draft stands — the check is an enhancement, not a gate
  }
}

export function makeScriptRole(): ScriptRole {
  return {
    async write(input) {
      const targetSeconds = Math.max(6, Math.min(90, input.targetSeconds ?? 24));
      const beatCount = Math.max(2, Math.min(14, Math.round(targetSeconds / 6)));
      const refNote = input.refs.length
        ? `The user attached ${input.refs.length} reference(s); keep the story consistent with them.`
        : "";
      const user = `Write a spoken video plan for this brief. Aim for about ${targetSeconds} seconds total across roughly ${beatCount} beats.
${refNote}
Brief: ${input.brief}`;
      const plan = await llmJson(SCRIPT_INSTRUCTIONS, user, parseScript);
      // A one-shot draft can silently drop something the brief asked for; the
      // coverage pass catches that at the source, before any style, sheet,
      // keyframe, or render spends against a story that doesn't match.
      return input.brief.trim() ? reviseForCoverage(input.brief.trim(), plan) : plan;
    },
  };
}

// ── breakdown (provided-audio mode) ─────────────────────────────────────────

const BREAKDOWN_INSTRUCTIONS = `You are a shot-list editor. Break a narration into a shot list that tiles the whole timeline.
Reply with JSON only:
{"shots": [
  {"start": number, "end": number, "action": string, "characters": ["char:1"], "location": "loc:1", "framing": string}
]}
Rules:
- start/end are SECONDS on the timeline; the shots must run in order and cover the whole duration with no gaps.
- Each shot is 2–8 seconds and depicts the concrete subject of the words heard across it. Cut a new shot at EVERY topic the narration touches — a two-second mention gets its own two-second shot, and the setting moves with the story (school, a strawberry patch, a pool); one backdrop must never absorb several ideas.
- Write action like a director's shot description, detailed enough to render the right moment without hearing the audio: who is on screen and their look, the specific activity mid-motion, the surroundings, and the camera's move.
- action is what the camera sees, never editing language: no "cut to", "transition", "fade", "montage" — the editor adds those between shots later.
- The brief, when given, is the source of truth for who speaks and who appears; the transcript is machine transcription that times the words and may mishear some — trust the brief over an odd transcription.
- framing is real camera language, varied shot to shot — wide establishing, close-up, insert of a telling detail, POV, follow shot — and action repeats the wardrobe and props that recur, so independently rendered shots still match.
- A shot cannot be trusted to render readable text: no signs, labels, charts, lists, or lettering beyond a single short word — the viewer already hears the information in the narration.
- Assign stable ids: characters "char:1"…, locations "loc:1"…, reused across shots for continuity. A shot with no character uses [].`;

/** Compact, timed transcript for the model — capped so a long narration stays
 * within a sane prompt. Words are grouped into ~2s chunks with a start stamp. */
function timedTranscript(words: TranscriptWord[]): string {
  if (words.length === 0) return "(no transcript — pace the shots evenly)";
  const lines: string[] = [];
  let chunkStart = words[0].t0;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) lines.push(`[${chunkStart.toFixed(1)}s] ${buf.join(" ")}`);
    buf = [];
  };
  for (const w of words) {
    if (buf.length && w.t0 - chunkStart >= 2) {
      flush();
      chunkStart = w.t0;
    }
    buf.push(w.w);
    if (lines.length >= 200) break;
  }
  flush();
  return lines.join("\n");
}

function parseShots(o: Record<string, unknown>, fps: number): RawShot[] | null {
  const rawShots = Array.isArray(o.shots) ? o.shots : [];
  if (rawShots.length === 0) return null;
  const shots: RawShot[] = rawShots
    .map((s): RawShot => {
      const shot = (s ?? {}) as Record<string, unknown>;
      return {
        startFrame: secToFrame(num(shot.start, 0), fps),
        endFrame: secToFrame(num(shot.end, 0), fps),
        action: str(shot.action),
        characters: idList(shot.characters),
        location: str(shot.location) || "loc:1",
        framing: str(shot.framing) || "medium shot",
      };
    })
    .filter((s) => s.endFrame > s.startFrame);
  return shots.length > 0 ? shots : null;
}

export function makeBreakdownRole(): BreakdownRole {
  return {
    async segment(input) {
      const durSec = input.durationFrames / input.fps;
      const briefNote = input.brief?.trim() ? `Brief: ${input.brief.trim()}\n` : "";
      // The shot count comes from the content: one shot per idea the words
      // touch. Duration only bounds the physics (coverage and the 2–8s slice
      // range); it never suggests a count.
      const user = `Cut this ${durSec.toFixed(1)}s narration into shots covering [0, ${durSec.toFixed(1)}]. The shot count comes from the content: list the distinct ideas the transcript touches, then give each its own shot — a narration that names six things needs six shots.
${briefNote}Timed transcript:
${timedTranscript(input.transcript)}`;
      return llmJson(BREAKDOWN_INSTRUCTIONS, user, (o) => {
        const shots = parseShots(o, input.fps);
        if (shots === null) return null;
        // Ground every shot in its own slice of the narration — the prompt
        // builder carries these words into the render.
        return shots.map((s) => ({
          ...s,
          audioText: wordsInRange(input.transcript, s.startFrame / input.fps, s.endFrame / input.fps),
        }));
      });
    },
  };
}

// ── style bible ─────────────────────────────────────────────────────────────

const STYLE_INSTRUCTIONS = `You are an art director. Design the visual world for a short video.
Reply with JSON only:
{"style": string, "negative": string, "characters": [{"id": "char:1", "name": string, "description": string}], "locations": [{"id": "loc:1", "name": string, "description": string}]}
Rules:
- style is one reusable paragraph every shot carries: medium, lighting, palette, camera, mood. Name the medium first and unambiguously — it is the instruction renders most often break. When reference images are attached, derive this wording from what they actually show: name their exact technique (linework, shading, color finish) so words and pixels agree. Pin the palette with precise color words ("flat marigold yellow", "warm cream skin, no gradient") — every shot is drawn independently, and only an exact name keeps a color the same across them.
- Reference images set the LOOK. A reference that is itself a character design — a turnaround sheet, or a single full-body character on a plain background — also sets a cast member's DESIGN: when the brief gives that character no appearance of its own, describe the cast member as exactly the pictured character (hair, face, eyewear, outfit, precise colors). Any other reference's people, characters, and creatures join the cast only when the brief asks for them; otherwise design the cast from the brief and describe them in the reference's technique, never as the pictured characters.
- negative is a short comma-separated list of what must never appear in this look: the wrong medium's tells. For a hand-drawn 2D look: "photorealistic rendering, live-action footage, 3D CGI, realistic skin texture, photographic lighting". For live-action: "cartoon rendering, cel shading, illustration". Tells only — subjects and story stay out.
- Return one entry per id you are asked to define, using those exact ids. description is a concrete visual of that subject/place — appearance, one fixed wardrobe, and the props the story repeats (a bag, a book, earphones) — so every shot renders the same person carrying the same things. Name each garment's and prop's color with the same precise words the style paragraph uses, and repeat those words verbatim wherever the item appears.
- Never name a real brand, franchise, show, studio, or artist — not even one the brief names. A generator rejects a trademarked name, so translate any such reference into its concrete visual traits: linework, proportions, palette, shading, era. (e.g. a named 1990s TV cartoon → "hand-drawn 2D animation, thick black outlines, flat bright colors, exaggerated rounded features, yellow-toned skin, simple suburban backdrops".)`;

function toAssets(
  raw: unknown,
  ids: string[],
  kind: "character" | "location"
): VideoAsset[] {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const byId = new Map(list.map((e) => [str(e.id), e]));
  return ids.map((id, i) => {
    const e = byId.get(id) ?? list[i] ?? {};
    return {
      id,
      kind,
      name: str(e.name) || (kind === "character" ? "the subject" : "the setting"),
      description: str(e.description) || (kind === "character" ? "the main subject" : "the scene"),
    };
  });
}

export function makeStyleRole(projectId: string): StyleRole {
  return {
    async design(input) {
      const charIds = distinct(input.beats.flatMap((b) => b.characters ?? []));
      const locIds = distinct(input.beats.map((b) => b.location ?? "").filter(Boolean));
      const wantLocs = locIds.length ? locIds : ["loc:1"];
      const story = input.beats
        .map((b, i) => `${i + 1}. ${b.action}${b.dialogue ? ` — "${b.dialogue}"` : ""}`)
        .join("\n");
      // The art director sees the actual reference pixels, so the style
      // wording names the real technique instead of guessing from the brief.
      const refParts = await refImageParts(projectId, input.refs);
      const refNote = refParts.length
        ? `The user's reference image(s) are attached — they define the look.`
        : "";
      const lookNote = input.style
        ? `The user pinned this look — style must realize it (translated per the rules): ${input.style}`
        : "";
      const user = `Design the look for this video.
Brief: ${input.brief || "(none)"}
${refNote}
${lookNote}
Story:
${story}
Define these characters (use these exact ids): ${charIds.join(", ") || "(none)"}
Define these locations (use these exact ids): ${wantLocs.join(", ")}`;
      return llmJson(
        STYLE_INSTRUCTIONS,
        user,
        (o) => {
          // A bible without a style paragraph is unusable — retried, never
          // silently replaced with a stand-in look.
          const style = str(o.style);
          if (!style) return null;
          return {
            style,
            ...(str(o.negative) ? { negative: str(o.negative) } : {}),
            characters: toAssets(o.characters, charIds, "character"),
            locations: toAssets(o.locations, wantLocs, "location"),
          };
        },
        refParts
      );
    },
  };
}
