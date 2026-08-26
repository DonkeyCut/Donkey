/**
 * The assistant's own tools — its senses on the project (state snapshot,
 * watching footage, listening, silence detection), the chat-driven fetch and
 * wait flows, and the server-handled skills library — kept beside the chat
 * panel that exposes the assistant. The catalog spreads this list into the
 * model's toolset and `aiTools.ts` keys its handlers on `AiPanelToolName`
 * (the `server: true` tools run in the engine and take no browser handler).
 */

import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const AI_PANEL_TOOLS = [
  {
    name: "get_state",
    description:
      "Read the full current editor state: clips, soundtrack, overlay elements (titles, shapes, stickers), subtitles, selection, playhead, view settings, publish metadata. Use this whenever the context snapshot is not enough or might be stale.",
    inputSchema: obj({}),
  },
  {
    name: "watch_video",
    description:
      "Watch a video source with your own eyes: samples candidate frames on a dense steady floor, keeps only the ones that actually differ, and tiles them into timestamped contact-sheet images — so every cell is a distinct moment and a gap between stamps means nothing changed there. Also returns sceneChanges, hard-cut times refined to about a third of a second of the true boundary (the time is where the new shot first appears) — though a shot shorter than the sampling step can fall between candidates, so where short cuts matter, re-watch narrow with a small interval_seconds. When the clip has captions or the source's own transcript exists, a fused timeline places each kept frame inside the speech it belongs to. Pass clip_id to watch a timeline clip's source (the result includes that clip's source↔timeline time math) or asset_id for any project video or image. The stamp burned into each cell is SOURCE seconds — what trim_clip's in/out use — not timeline seconds. Coverage ends where the result says it does: `coveredTo` is how far you have looked and `unwatchedSeconds` is how much of the source you have NOT — everything before coveredTo was seen, nothing after it was. Continue from coveredTo until unwatchedSeconds is 0 before you describe, summarize, or reproduce the source as a whole; a `to` you chose yourself ends a call with truncated false and the rest of the video still unseen. Watching builds the source's frame map (moment times + cut candidates), persisted on the asset; media entries list those spans as `mapped`, and your first watch starts a quiet background sweep that maps the rest (`watching: true` while it runs). The map aims your watches — a mapped span is NOT footage you have seen; only sheets returned in this conversation are, so watch any span you need to actually look at. Every pass ends with note_source: the sheets are conversation-local and drop out as the chat grows, so write what this stretch showed against its source seconds and it stays on the asset for every later turn. The result carries `recorded` (what is already written about the stretch you just watched) and `unnoted` (the spans of this source nothing describes yet); watching a source that still owes a note is refused. Read the watching-and-cutting skill before editing footage by content.",
    inputSchema: obj({
      clip_id: str("Video clip id, track 0 or overlay (defaults from/to to its trimmed in/out)"),
      asset_id: str("Project asset id (video or image) — watch the source itself"),
      from: num("Source start s (default: the clip's in, else 0)"),
      to: num("Source end s (default: the clip's out, else the source's end; spans at most 600s per call)"),
      interval_seconds: num("Seconds between candidate frames, 0.5–30 (default 1; near-duplicates are dropped, so a dense default costs nothing)"),
    }),
  },
  {
    name: "note_source",
    description:
      "Write down what you just saw in a source, against the source seconds it covers. Contact sheets live in this conversation only and the oldest media drops out as the chat grows, so a source longer than one look is only usable if each look is recorded while it is on screen: the notes save onto the asset, ride the editor state into every later turn and every later chat, and come back in get_state and in watch_video's `recorded`. Write what a later decision needs — on-screen text word for word, what happens, how it is shot, where the cuts land — one entry per stretch you looked at. A note owns its span: re-reading 0-30s closely and noting it again replaces the coarse note that covered it. Watching a source that still has an unrecorded look behind it is refused, so note as you go.",
    inputSchema: obj(
      {
        clip_id: str("Video clip id — records against that clip's source"),
        asset_id: str("Project asset id"),
        notes: {
          type: "array",
          description: "One entry per stretch you looked at, in source seconds",
          items: obj(
            {
              from: num("Source start s"),
              to: num("Source end s"),
              text: str("What that stretch showed — quote on-screen text exactly"),
            },
            ["from", "to", "text"]
          ),
        },
      },
      ["notes"]
    ),
  },
  {
    name: "detect_silence",
    description:
      "Find silent stretches in a source's audio — dead air, long pauses, gaps between takes. Returns [{start,end,duration}] in SOURCE seconds, plus each one's timeline times when clip_id is passed. Cheap and image-free; pair it with the transcript's cue timings to find filler, then cut with split_at / trim_clip / delete_item — place speech cuts inside these spans (cue timings drift from the audio), and read the watching-and-cutting skill for the pacing rules.",
    inputSchema: obj({
      clip_id: str("Clip id — video, overlay, or soundtrack; scopes to its trimmed range and maps results to timeline seconds"),
      asset_id: str("Project asset id (video or audio)"),
      from: num("Source start s (default: the clip's in, else 0)"),
      to: num("Source end s (default: the clip's out, else the source's end)"),
      threshold_db: num("Loudness below this counts as silence, dBFS (default -30)"),
      min_silence: num("Shortest silent stretch to report, seconds (default 0.35)"),
    }),
  },
  {
    name: "detect_beats",
    description:
      "Read a source's musical beat grid — the tempo and where each beat lands — for cutting to the music. Returns bpm and beats in SOURCE seconds; with clip_id it also returns timelineBeats, the beats inside the clip's trimmed range mapped to timeline seconds, ready for split_at. The grid persists on the asset: its clips draw the beats as yellow dots and every drag or trim snaps to them, so one detection serves the whole edit. A stored grid comes back as-is — the user can hand-edit the dots, and their edits hold, and a grid they have edited reports bpm 0 because the tempo is theirs now — so pass regenerate only to re-scan and replace it. Detection always reads the whole source; from/to just window the reply.",
    inputSchema: obj({
      clip_id: str("Clip id — video, overlay, or soundtrack; windows the reply to its trimmed range and maps beats to timeline seconds"),
      asset_id: str("Project asset id (video or audio)"),
      from: num("Source start s (default: the clip's in, else 0)"),
      to: num("Source end s (default: the clip's out, else the source's end)"),
      regenerate: bool("Re-scan and replace a stored grid, dropping any hand edits (default false)"),
    }),
  },
  {
    name: "listen_audio",
    description:
      "Listen with your own ears to a project asset's sound — an audio asset, or the audio track of a video (its speech, music, burned-in narration) — so you can answer what it says or how it sounds. For the WORDS alone, check the source's transcript first: media entries marked speech: 'transcribed' carry timed segments (get_state includes them) at no audio cost; listen when you need the sound itself — tone, music, delivery, timing by ear. The sound rides back inline (≈12MB cap). Pass clip_id for a timeline clip's source (scopes to its trim) or asset_id for the whole source; add from/to (source seconds) to hear one stretch of a long file. Audio the user attached to their message already plays in it. To WRITE a caption track, use subtitles_generate.",
    inputSchema: obj({
      clip_id: str("Clip id — video or soundtrack (defaults from/to to its trimmed in/out)"),
      asset_id: str("Project asset id (audio or video) — listen to the whole source"),
      from: num("Source start s (default: the clip's in, else 0)"),
      to: num("Source end s (default: the clip's out, else the source's end)"),
    }),
  },
  {
    name: "wait_for_renders",
    description:
      "Block until this project's in-flight video renders settle (up to ~100s), then report each one: landed (with its asset id, ready to place) or failed (with the error). Call it whenever the user's ask depends on a render that `renders` in the state shows as running — \"add it when it's done\", \"assemble the clips\" — and then finish the job in the same turn; never tell the user to come back and report when a card appears. If some renders are still running when it returns, say how long they've been going and call it again on the user's go-ahead.",
    inputSchema: obj({}),
  },
  {
    name: "import_url",
    description:
      "Read any URL — TikTok, YouTube, Instagram Reels, an X/Twitter post or Article, an ordinary web page, or a direct video/audio/image link — with the bundled downloader and import what it holds into the project. Free and local. A web page comes back as its article text plus the pictures on it; a post as its video or photos; and the source's own words (returned as sourceText) are quoted for the user beside the media automatically — don't retype them in your reply. A source that is only words returns sourceText with no assets, which is a success: read it and answer from it. This is how you look something up: point it at the page and read what comes back. Media lands on a card in this chat and the user drags it to the timeline, Media, or the Library; place it yourself (add_clip) only when they asked for it in the cut. A short clip downloads in seconds; a long video can take a couple of minutes.",
    inputSchema: obj({ url: str("The page or media URL to download") }, ["url"]),
  },
  {
    name: "list_skills",
    description: "List the available skill documents about how this editor works.",
    inputSchema: obj({}),
    server: true,
  },
  {
    name: "read_skill",
    description:
      "Read a skill document (detailed docs for a part of the editor: every setting, where it lives, and how it behaves). Use before working in an unfamiliar area.",
    inputSchema: obj({ name: str("Skill name from list_skills") }, ["name"]),
    server: true,
  },
] as const satisfies readonly AiToolDef[];

export type AiPanelToolName = (typeof AI_PANEL_TOOLS)[number]["name"];
