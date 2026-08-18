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
    name: "sync_lyrics",
    description:
      "Time a text the user already has — song lyrics, a script, a poem — to the audio in the cut, and put it on a caption track. Transcribes the cut first when the track is empty, then aligns the user's words to the recognized ones and keeps the user's text exactly as written: the recognizer supplies the clock, never the wording, which is what makes it work on singing it half-mishears. Words it missed take interpolated times from the words around them. Pass `look` to dress the track in a text-videos look at the same time (karaoke word highlight included). For lyrics as full-frame cards rather than captions, follow this with add_text_sequence from_captions.",
    inputSchema: obj(
      {
        text: str("The lyrics or script, one line per screen (newline separated)"),
        track: num("Subtitle track to write, 0-based (default: the active track)"),
        look: str("Text-videos look id to dress the captions in"),
        from: num("Ignore audio before this timeline second"),
        to: num("Ignore audio after this timeline second"),
        background: bool("With `look`, also set the project background to its frame color (default true)"),
      },
      ["text"]
    ),
  },
  {
    name: "set_caption_look",
    description:
      "Style the caption track: a text-videos look id in `look` sets everything at once (preset, size, font, karaoke highlight, accent color, frame background), or set the pieces yourself. Karaoke — word_highlight — lights each word as it is spoken or sung, in the preview and the export burn-in; it needs word timings, which transcription and sync_lyrics leave on the cues.",
    inputSchema: obj({
      look: str("Text-videos look id — sets the whole caption look"),
      style: str("Caption preset: clean, hook, punchy, minimal, editorial, typewriter, block, highlight, bubble, neon"),
      size: num("Caption size in px at a 1080-wide frame"),
      font: str("Font id"),
      word_highlight: bool("Light each word as it lands (karaoke)"),
      accent_color: str("Highlight color"),
      accent_mode: { type: "string", enum: ["color", "underline", "box"], description: "How the word lights up" },
      x: num("Caption center x 0..1"),
      y: num("Caption center y 0..1"),
      background: bool("With `look`, also set the project background (default true)"),
    }),
  },
  {
    name: "subtitles_add_track",
    description:
      "Add a subtitle track for an additional language (up to 3, one language each — e.g. English on track 0, Korean on track 1; each shows as its own caption line, draggable to its own spot). The new track becomes active and starts empty: fill it with subtitles_translate_track, or subtitles_generate in its language. Plain \"add captions\" is subtitles_generate by itself — it writes the default track.",
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
