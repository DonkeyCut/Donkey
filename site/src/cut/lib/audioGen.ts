"use client";

import { bytesFromBase64 } from "./bytes";
import { readHostedFailure } from "./hostedError";
import { hostedPost } from "./hosted";
import { importFileToProject } from "./media";
import { mediaSlug, type MediaAsset } from "./types";
import { UserError } from "./userError";
import type { MusicLength } from "@/lib/credits/price-sheet";

// Client side of AI music generation: Gemini/Lyria on Donkey's hosted inference
// routes, with the user's Donkey sign-in and credits (same-origin on the cut
// hosts, like image/video/voiceover generation). The prompt describes the mood
// and genre; the model renders a track — a full song with sung vocals, or an
// instrumental bed when asked — that comes back inline and saves into the
// project through the local engine like any other media file.

export type MusicVariant = MusicLength;

/** The length choices the Music generator offers — the clip model renders a
 * short bed, the pro model a full-length track. */
export const MUSIC_VARIANTS: { id: MusicVariant; label: string; hint: string }[] = [
  { id: "clip", label: "Clip", hint: "~30 sec" },
  { id: "song", label: "Full track", hint: "~2 min" },
];

const readFailure = (res: Response, fallback: UserError) =>
  readHostedFailure(res, new UserError("sign_in_to_generate_music", "Sign in to Donkey to generate music."), fallback);

/** Display name for the track: the prompt, tidied and capped. */
function musicName(prompt: string) {
  const line = prompt.trim().replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/** Generate one music track and save it into the project as a generated audio
 * asset. By default the model may sing (a full song); pass `instrumental` for a
 * vocal-free bed. Returns the asset (unplaced) — callers register it in the store
 * and decide placement, exactly like synthesizeSpeech. */
export async function synthesizeMusic(
  projectId: string,
  prompt: string,
  opts?: { variant?: MusicVariant; instrumental?: boolean; name?: string }
): Promise<MediaAsset> {
  // Lyria sings by default; the explicit clause is how you get an instrumental
  // bed (the model has no separate flag — it reads it from the prompt).
  const sent = opts?.instrumental ? `${prompt.trim()} Instrumental only, no vocals.` : prompt;
  const res = await hostedPost("/api/inference/assets", {
    kind: "music",
    prompt: sent,
    // Route to Lyria; the neutral `variant` picks the length (the model ids stay
    // server-side). Omit for the default clip.
    provider: "gemini-music",
    ...(opts?.variant === "song" ? { parameters: { variant: "song" } } : {}),
  });
  if (!res.ok) {
    throw await readFailure(res, new UserError("music_generation_failed", "Music generation failed."));
  }
  const gen = (await res.json()) as {
    outputs?: { dataBase64?: string; url?: string; contentType?: string; filename?: string }[];
  };
  const out = gen.outputs?.find((o) => o.dataBase64) ?? gen.outputs?.find((o) => o.url);

  // Cap whatever the label comes from — a caller-supplied name (the user's own
  // words when the prompt was composed from references) or the prompt itself.
  const label = musicName(opts?.name?.trim() || prompt);
  const fileName = `ai-${mediaSlug(label, "ai-music")}.mp3`;
  let file: File;
  if (out?.dataBase64) {
    file = new File([bytesFromBase64(out.dataBase64)], out.filename ?? fileName, {
      type: out.contentType ?? "audio/mpeg",
    });
  } else if (out?.url) {
    const dl = await fetch(out.url);
    if (!dl.ok) {
      throw new UserError("music_download_failed", "Could not download the generated music.");
    }
    file = new File([await dl.arrayBuffer()], fileName, {
      type: out.contentType ?? "audio/mpeg",
    });
  } else {
    throw new UserError("music_output_missing", "The provider returned no music.");
  }

  const asset = await importFileToProject(projectId, file);
  if (!asset) {
    throw new UserError("music_save_failed", "Could not save the generated music into the project.");
  }
  asset.name = label;
  // Generated (not a user import): stays out of the Media panel and lists in the
  // Audio tab's Music generator. A chat-made track is re-tagged to its thread by
  // the caller (tagChatAsset), like every other generated asset.
  asset.origin = "generated";
  return asset;
}
