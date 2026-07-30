"use client";

import { geminiModelRoles } from "@/lib/inference/gemini-models";
import type { AssetRef } from "./assetRef";
import { hostedPost } from "./hosted";
import { readRefText, refsToParts, type InlineImage } from "./refMedia";

// Reference-aware prompt composition, shared by video and image generation.
//
// The generators read their input images literally: the video model plays its one input
// image as the video's first frame, and the image model edits the pixels it is
// given. So a prompt that asks to *transform* a reference ("turn this into a
// korean woman") loses to the picture, and text-file references (a script,
// notes) can't ride as images at all. Before rendering, a small multimodal
// Gemini call reads every reference — video frames, images, text contents —
// plus the user's request, rewrites the prompt to stand alone, and picks which
// pictures should still ride to the generator. Best-effort throughout: any
// failure returns null and the caller falls back to the raw prompt + refs.

const VIDEO_INSTRUCTIONS = `You prepare prompts for a text+image-to-video model. The numbered images and attached files are the user's references; their request comes last. The model accepts at most one input image and plays it as the video's literal first frame — it can animate what is pictured but cannot change who or what is in it.
Reply with JSON {"prompt": string, "keepImages": number[]}:
- keepImages lists at most one image number: the one whose exact pixels should open the video. Keep an image only when the request uses its subject as-is (animate it, continue the shot, have them speak). Keep none when the request transforms or replaces what any reference shows.
- prompt must stand alone: fold in everything the video needs from every reference — setting, framing, lighting, wardrobe, camera, mood, action, any script or text from attached files — with the requested changes applied. Describe subjects concretely; if anyone speaks, give them a matching voice and the words to say.
- A frame labelled as pinned is the user's chosen moment; frames sampled near it are the same moment a beat earlier/later. Treat the pinned frame as the reference, and when one of them should ride, keep the one that shows the subject best.
- The video model never hears attached audio. Fold what it carries into the prompt: speech becomes the words a speaker says, music or ambience becomes a concrete description of the video's own sound.`;

const IMAGE_INSTRUCTIONS = `You prepare prompts for an image generation and editing model. The numbered images and attached files are the user's references; their request comes last. The model receives the kept images as inputs it can edit, combine, and draw from.
Reply with JSON {"prompt": string, "keepImages": number[]}:
- keepImages lists the image numbers the model should receive: keep the ones the request edits, combines, or borrows a subject or style from; drop ones whose contribution is better said in words.
- prompt must stand alone given only the kept images: refer to them by their content, and fold in whatever matters from the dropped references and any script or text from attached files, with the requested changes applied.
- A frame labelled as pinned is the user's chosen moment; frames sampled near it are the same moment a beat earlier/later. Treat the pinned frame as the reference, and when one of them should ride, keep the one that shows the subject best.
- The image model never hears attached audio. Fold what it carries into the prompt: transcribe speech that should appear, translate music or ambience into the mood and setting it implies.`;

const MUSIC_INSTRUCTIONS = `You prepare prompts for a text-to-music model that generates a track from a text description alone — it never hears or sees the references. The attachments are what the user wants the music to match: an audio track to emulate, or video/images whose mood the score should carry. Their request comes last.
Reply with JSON {"prompt": string}:
- prompt must fully describe the SOUND to generate so a new track can match the reference: genre, instrumentation, vocal style and gender (or that it is instrumental), mood, energy, tempo, and production feel. For an audio reference, describe what you actually hear — groove, arrangement, key feel — closely enough to recreate it; for visual references, translate their tone and pacing into music. Keep any language the lyrics should be in.
- Describe everything by its musical traits. Never name a real artist, band, song, album, or brand — the model rejects those; state the characteristics instead.`;

export interface ComposedGen {
  prompt: string;
  /** The reference pictures the generator should receive, in kept order. */
  images: InlineImage[];
}

/** Compose a generation prompt from the user's request and their references.
 * Null on any failure (or when no ref contributes anything) — callers fall
 * back to sending the raw prompt with the visual refs as-is. */
export async function composeGenPrompt(
  target: "video" | "image",
  prompt: string,
  refs: AssetRef[]
): Promise<ComposedGen | null> {
  try {
    const { parts, visuals } = await refsToParts(refs);
    if (parts.length === 0) return null;
    const res = await hostedPost("/api/inference/responses", {
      donkeyProvider: "gemini",
      model: geminiModelRoles.chat,
      instructions: target === "video" ? VIDEO_INSTRUCTIONS : IMAGE_INSTRUCTIONS,
      response_format: { type: "json_object" },
      input: [{ role: "user", content: [...parts, { text: `Request: ${prompt}` }] }],
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { output_text?: string };
    const parsed = JSON.parse(body.output_text ?? "") as {
      prompt?: unknown;
      keepImages?: unknown;
    };
    if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) return null;
    const keep = Array.isArray(parsed.keepImages)
      ? parsed.keepImages.filter(
          (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= visuals.length
        )
      : [];
    return { prompt: parsed.prompt.trim(), images: keep.map((n) => visuals[n - 1]) };
  } catch {
    return null;
  }
}

/** Compose a music-generation prompt from the user's request and their media
 * references. The music model reads only text, so a multimodal pass listens to
 * each audio reference and looks at each visual one, then folds a description
 * of the target sound into a stand-alone prompt. Null on any failure (or when
 * no ref contributes anything) — the caller falls back to the raw prompt. */
export async function composeMusicPrompt(
  prompt: string,
  refs: AssetRef[]
): Promise<string | null> {
  try {
    const { parts } = await refsToParts(refs);
    if (parts.length === 0) return null;
    const res = await hostedPost("/api/inference/responses", {
      donkeyProvider: "gemini",
      model: geminiModelRoles.chat,
      instructions: MUSIC_INSTRUCTIONS,
      response_format: { type: "json_object" },
      input: [{ role: "user", content: [...parts, { text: `Request: ${prompt}` }] }],
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { output_text?: string };
    const parsed = JSON.parse(body.output_text ?? "") as { prompt?: unknown };
    if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) return null;
    return parsed.prompt.trim();
  } catch {
    return null;
  }
}

/** Fallback text folding for when the compose call fails: append each text
 * ref's contents to the prompt so a dropped script still reaches the
 * generator. Unreadable files are skipped. */
export async function foldTextRefs(prompt: string, refs: AssetRef[]): Promise<string> {
  const blocks = await Promise.all(
    refs
      .filter((r) => r.kind === "text")
      .map((r) =>
        readRefText(r).then(
          (contents) => `Contents of "${r.name}":\n${contents}`,
          () => null
        )
      )
  );
  const kept = blocks.filter((b): b is string => b !== null);
  return kept.length > 0 ? `${prompt}\n\n${kept.join("\n\n")}` : prompt;
}
