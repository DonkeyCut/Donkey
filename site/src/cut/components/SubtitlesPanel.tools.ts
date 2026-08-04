/**
 * The assistant's subtitle tools — transcription, caption rewriting, track
 * management, per-cue edits, and the caption view toggles — kept beside the
 * subtitles panel that exposes the same transcript editor. The catalog
 * spreads this list into the model's toolset and `aiTools.ts` keys its
 * handlers on `SubtitlesToolName`.
 */

import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const SUBTITLES_TOOLS = [
  {
    name: "subtitles_generate",
    description:
      "Transcribe the cut on-device (Apple speech) and create subtitle captions on a subtitle track (the active one unless `track` says otherwise; other tracks keep their captions) — it WRITES captions the user sees, so call it only when they asked for subtitles; to just hear what an audio asset says, listen_audio. Cue times come back snapped to the audio, so treat them as in sync — retime a cue only when the user points at one. Runs in the background; returns when finished. If no speech is found, no subtitles are added.",
    inputSchema: obj({
      locale: str("Speech language as BCP-47 like en-US (default: the track's language)"),
      track: num("Subtitle track to write, 0-based (default: the active track)"),
    }),
  },
  {
    name: "captions_generate",
    description:
      "Transcribe (if needed) then REWRITE one subtitle track's captions into punchy social-video captions — short lines that fit inside the video frame (they may wrap onto two lines but never overflow), a few emoji, a curiosity-hook opener. style: clean | hook | punchy (default hook). Cue timings are preserved. It replaces the track's existing text wholesale — for a targeted edit (removing filler words, fixing one line), edit the cues with update_cue instead.",
    inputSchema: obj({
      style: str("Caption style: clean, hook, or punchy"),
      track: num("Subtitle track to rewrite, 0-based (default: the active track)"),
    }),
  },
  {
    name: "subtitles_from_visuals",
    description:
      "Caption a cut that has NO usable speech by watching sampled frames and writing timed narration captions (uses the user's Claude login to look at the frames). Use this instead of subtitles_generate when the video is silent b-roll, music-only, or otherwise has nothing to transcribe. Runs in the background; returns when finished.",
    inputSchema: obj({
      locale: str("Caption language as BCP-47 like en-US (default: the track's language)"),
      track: num("Subtitle track to write, 0-based (default: the active track)"),
    }),
  },
  {
    name: "subtitles_add_track",
    description:
      "Add a subtitle track (up to 3, one language each — e.g. English on track 0, Korean on track 1; each shows as its own caption line, draggable to its own spot). The new track becomes active and starts empty: fill it with subtitles_translate_track, or subtitles_generate in its language.",
    inputSchema: obj({ language: str("The track's language as BCP-47, e.g. ko-KR (optional)") }),
  },
  {
    name: "subtitles_remove_track",
    description:
      "Remove a subtitle track and its captions; higher tracks shift down. Removing the only track empties it — so this also answers \"delete the subtitles\".",
    inputSchema: obj({ track: num("Track to remove, 0-based") }, ["track"]),
  },
  {
    name: "subtitles_translate_track",
    description:
      "Translate existing captions into another language on their own subtitle track — the way to answer \"add Korean subtitles\". Reuses the track already set to that language or adds one (max 3), then translates the source track's cues one-to-one, timings kept. The captions must exist first (subtitles_generate).",
    inputSchema: obj({
      language: str("Target language as BCP-47, e.g. ko-KR"),
      from_track: num("Source track, 0-based (default: the first track with captions)"),
    }, ["language"]),
  },
  {
    name: "subtitles_set_view",
    description: "Toggle subtitles on the video (preview + export burn-in) and/or the timeline cue track.",
    inputSchema: obj({ showOnVideo: bool("Captions on the video"), showOnTimeline: bool("Cue track on the timeline") }),
  },
  {
    name: "update_cue",
    description: "Edit a subtitle cue's text or retime it (start/end seconds).",
    inputSchema: obj({ id: str("Cue id"), text: str("New text"), start: num("Start s"), end: num("End s") }, ["id"]),
  },
  {
    name: "delete_cue",
    description: "Delete a subtitle cue.",
    inputSchema: obj({ id: str("Cue id") }, ["id"]),
  },
  {
    name: "merge_cue",
    description:
      "Merge a subtitle cue into the previous cue on its own track (joins their text and timing). Not valid for a track's first cue.",
    inputSchema: obj({ id: str("Cue id to merge into its predecessor") }, ["id"]),
  },
] as const satisfies readonly AiToolDef[];

export type SubtitlesToolName = (typeof SUBTITLES_TOOLS)[number]["name"];
