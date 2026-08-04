/**
 * The assistant's audio-generation tools — AI voiceover, the voice list,
 * music generation, and speaking a subtitle track aloud — kept beside the
 * Audio panel whose Voice and Music sub-tabs expose the same generators.
 * The catalog spreads this list into the model's toolset and `aiTools.ts`
 * keys its handlers on `AudioToolName`.
 */

import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const AUDIO_TOOLS = [
  {
    name: "list_voices",
    description:
      "List the AI voices available for voiceover (Gemini's prebuilt set; each has a one-word character like Warm, Upbeat, Gravelly). Call this when the user asks for a specific kind of voice so you can pass the right voice id to voiceover_generate or read_subtitles_aloud.",
    inputSchema: obj({}),
  },
  {
    name: "voiceover_generate",
    description:
      "Generate a spoken AI voiceover from a script (Donkey's hosted speech model). The audio previews as a playable card in this chat; pass add_to_timeline:true (or a `start`) to also drop it on the soundtrack when the user asked for it in the cut ('add a voiceover', 'narrate this'). When the user asks you to write or rework the script itself, put the text in chat and wait for them to ask for the voiceover. Pick a `voice` id from list_voices, or omit for a good default. `direction` steers delivery in natural language and can ask for another language — 'say it in Spanish' translates the script before synthesis; the script itself may carry inline tags like [whispers] or [excited]. `duck` lowers all other audio to that gain while the voice plays (0..1; ~0.3–0.5 is typical, 1 = don't duck). Needs the user signed in to Donkey (spends their credits).",
    inputSchema: obj({
      script: str("What the voice should say"),
      voice: str("Voice id from list_voices (optional; a sensible default is chosen)"),
      direction: str("Delivery instruction, e.g. 'Say warmly, like an old friend'; may include a language ask, which translates the script (optional)"),
      language: str("Pronunciation language as BCP-47, e.g. es-US, ja-JP (optional; default auto-detects — this reads the script as written, it does not translate)"),
      duck: num("Lower other audio to this gain while the voice plays, 0..1 (default 0.4; 1 = no ducking)"),
      add_to_timeline: bool("Place it on the soundtrack (default false — it stays on its chat card until the user asks)"),
      start: num("Timeline start in seconds (passing it implies add_to_timeline; default when placed: the playhead)"),
    }, ["script"]),
  },
  {
    name: "generate_music",
    description:
      "Generate a music track from a text prompt (Donkey's hosted music model, Gemini/Lyria) — a full song with sung vocals, or an instrumental bed. Describe mood, genre, instruments, and tempo. By default it renders an instrumental bed (instrumental:true); pass instrumental:false for a full song, where the model writes and sings its own lyrics — or include your own with [Verse]/[Chorus] tags and a singer description in the prompt. length \"clip\" is ~30s (default), \"song\" a longer ~2-minute track. reference_asset_ids matches a track to the user's own media (\"a song that matches this audio\", \"score the tone of this video\"): pass the project asset ids — an audio track to emulate, or video/images whose mood to carry — and a multimodal pass folds a description of that sound into the prompt (the model itself never hears the audio, so always pass the reference rather than describing it yourself). When you match an audio reference that has singing, pass instrumental:false so the new track sings too. When the user asks you to write or refine the lyrics or brief itself, put it in chat and wait for them to ask for the music. It RETURNS once the track has landed and previews as a playable card in this chat; pass add_to_timeline:true (or a `start`) to drop it on the soundtrack when the user asked for it in the cut. For \"background music for this video\", read the timeline (videoTrack, project duration) to fit the mood and length, keep it instrumental so any speech stays on top, and set those clips' `duck` so the bed dips under them. This is SUNG music — a spoken narration is voiceover_generate. Needs the user signed in to Donkey (spends their credits).",
    inputSchema: obj({
      prompt: str("The music to generate — mood, genre, instruments, tempo; for a song, the theme to sing about, or your own [Verse]/[Chorus] lyrics"),
      instrumental: bool("Vocal-free background bed (default true). Pass false to let the model write and sing a full song"),
      length: { type: "string", enum: ["clip", "song"], description: "clip = ~30s (default), song = ~2-minute track" },
      reference_asset_ids: {
        type: "array",
        items: { type: "string" },
        description: "Project asset ids to match the sound of — an audio track to emulate, or video/images whose mood the score should carry. Append @seconds to match the passage around a pinned moment (\"<id>@62\")",
      },
      volume: num("Bed volume 0..1.5 when placed (default 0.4 so it sits under speech)"),
      add_to_timeline: bool("Place it on the soundtrack (default false — it stays on its chat card until the user asks)"),
      start: num("Timeline start in seconds (passing it implies add_to_timeline; default when placed: the playhead)"),
    }, ["prompt"]),
  },
  {
    name: "read_subtitles_aloud",
    description:
      "Speak one subtitle track's cues as an AI voiceover (Donkey's hosted speech model) — each line placed at its own cue time — and add it to the soundtrack. Turns captions into narration. Requires subtitles to exist first (generate them if needed). `duck` lowers other audio under the voice (0..1). Needs the user signed in to Donkey (spends their credits).",
    inputSchema: obj({
      voice: str("Voice id from list_voices (optional)"),
      direction: str("Delivery instruction, e.g. 'Narrate briskly, documentary style'; may include a language ask, which translates the lines (optional)"),
      language: str("Pronunciation language as BCP-47, e.g. es-US, ja-JP (optional; default auto-detects — reads cues as written; for another language use a translated subtitle track)"),
      duck: num("Lower other audio to this gain while the voice plays, 0..1 (default 0.4)"),
      track: num("Subtitle track to read, 0-based (default: the active track)"),
    }),
  },
] as const satisfies readonly AiToolDef[];

export type AudioToolName = (typeof AUDIO_TOOLS)[number]["name"];
