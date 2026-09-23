/**
 * The assistant's own tools — its senses on the project (state snapshot,
 * watching footage, listening, silence detection), the chat-driven fetch and
 * wait flows, and the server-handled skills library — kept beside the chat
 * panel that exposes the assistant. The catalog spreads this list into the
 * model's toolset and `aiTools.ts` keys its handlers on `AiPanelToolName`
 * (the `server: true` tools run in the engine and take no browser handler).
 */

import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
import { WATCH_DETAIL_NOTES, WATCH_DETAILS } from "@/cut/lib/types";

export const AI_PANEL_TOOLS = [
  {
    name: "get_state",
    description:
      "Read the full current editor state: clips, soundtrack, overlay elements (titles, shapes, stickers), subtitles, selection, playhead, view settings, publish metadata. Use this whenever the context snapshot is not enough or might be stale.",
    inputSchema: obj({}),
  },
  {
    name: "get_asset_info",
    description:
      "Read a project asset's file name, kind, exact file size in bytes, duration in seconds, and pixel dimensions. Use this for file-size questions when sizeBytes is absent from the media snapshot. Reads file metadata across browser, Mac, and cloud storage.",
    inputSchema: obj({ asset_id: str("Project asset id from media or an import result") }, ["asset_id"]),
  },
  {
    name: "watch_video",
    description:
      "Watch a video source with your own eyes: samples candidate frames on a dense steady floor plus one just after each line the source speaks — what a video shows changes when what it says changes, so a transcribed source is read on its own clock and a caption track lands a frame per card — keeps only the ones that actually differ, and tiles them into timestamped contact-sheet images — so every cell is a distinct moment and a gap between stamps means nothing changed there. Also returns sceneChanges, hard-cut times refined to about a third of a second of the true boundary (the time is where the new shot first appears) — though a shot shorter than the sampling step can fall between candidates, so where short cuts matter, re-watch narrow with a small interval_seconds. When the clip has captions or the source's own transcript exists, a fused timeline places each kept frame inside the speech it belongs to. Pass clip_id to watch a timeline clip's source (the result includes that clip's source↔timeline time math) or asset_id for any project video or image. `detail` decides how many pixels each kept frame is worth: scan tiles many small cells for coverage, read enlarges them for on-screen text, original hands back the source's own frames for matching type, colour and edges. A contact-sheet cell is a quarter of the frame's width, so a small caption arrives too small to read — when the job is words on screen or a look to reproduce, spend the pixels instead of guessing. `textFits` comes back with the frames: the parts of the picture that stay quiet across everything just watched, inside whatever the project's guides keep clear, quietest first — where a title or caption can go without covering the subject or the source's own on-screen text. The stamp burned into each cell is SOURCE seconds — what trim_clip's in/out use — not timeline seconds. Coverage ends where the result says it does: `coveredTo` is how far you have looked and `unwatchedSeconds` is how much of the source you have NOT — everything before coveredTo was seen, nothing after it was. Reading is measured apart from seeing: `unreadSeconds` is how much of the source no pass has looked at closely enough to read its type, and `unreadFrom` is where the next close pass starts. Both ride the asset, so they carry what every earlier chat read as well as this one. Continue from coveredTo until unwatchedSeconds is 0 before you describe, summarize, or reproduce the source as a whole; a `to` you chose yourself ends a call with truncated false and the rest of the video still unseen. Watching builds the source's frame map (moment times + cut candidates), persisted on the asset; media entries list those spans as `mapped`, and your first watch starts a quiet background sweep that maps the rest (`watching: true` while it runs). The map aims your watches — a mapped span is NOT footage you have seen; only sheets returned in this conversation are, so watch any span you need to actually look at. Every pass ends with note_source: the sheets are conversation-local and drop out as the chat grows, so write what this stretch showed against its source seconds and it stays on the asset for every later turn. The result carries `recorded` (what is already written about the stretch you just watched) and `unnoted` (the spans of this source nothing describes yet); watching a source that still owes a note is refused. Read the watching-and-cutting skill before editing footage by content.",
    inputSchema: obj({
      clip_id: str("Video clip id, track 0 or overlay (defaults from/to to its trimmed in/out)"),
      asset_id: str("Project asset id (video or image) — watch the source itself"),
      from: num("Source start s (default: the clip's in, else 0)"),
      to: num("Source end s (default: the clip's out, else the source's end; spans at most 600s per call)"),
      interval_seconds: num("Seconds between candidate frames, 0.5–30 (default 1; near-duplicates are dropped, so a dense default costs nothing)"),
      detail: {
        type: "string",
        enum: [...WATCH_DETAILS],
        description: `How much of each frame comes back (default scan). ${WATCH_DETAILS.map((d) => `${d}: ${WATCH_DETAIL_NOTES[d]}`).join(". ")}. The moments kept are the same at every step — only the pixels spent on each change, and small on-screen type is unreadable below "read". Scan a source first, then re-watch the stretch that matters at the detail its content needs.`,
      },
      project_link: str(
        "A reference project's link or id (what read_project took): clip_id / asset_id then name that project's items, so you can look at footage of the reference whose notes and transcript leave it dark before mapping roles. A reference look is for deciding — nothing is written to the reference and no note is owed."
      ),
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
      "Find silent stretches in a source's audio — dead air, long pauses, gaps between takes. Returns [{start,end,duration}] in SOURCE seconds, plus each one's timeline times when clip_id is passed. Cheap and image-free; find_filler finds the filler words, then cut with split_at / trim_clip / delete_item — place speech cuts inside these spans (cue timings drift from the audio), and read the watching-and-cutting skill for the pacing rules.",
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
    name: "find_filler",
    description:
      "Find the filler words in a subtitle track's transcript — um, uh, a stranded 'like' or 'you know', stutters, repeated words — each judged in its sentence. Returns [{cue_id, text, start, end}] in TIMELINE seconds, neighbouring filler words merged into one span so each entry is one cut, (the cues' own word timings), plus each word's source times when clip_id is passed, so you can cut the speech with split_at / delete_item / trim_clip or tidy the captions with update_cue. Needs a transcribed track (subtitles_generate) first. Words marked estimated sit in cues that lost their word timings.",
    inputSchema: obj({
      track: num("Subtitle track, 0-based (default: the active one)"),
      clip_id: str("Video clip id — scopes to its timeline span and maps each word to source seconds"),
    }),
  },
  {
    name: "measure_level",
    description:
      "Measure how loud clips actually play — the level of each clip's audible sound over its trimmed range, in dBFS, with its current volume applied — so volumes are set from numbers, never by ear. Returns per clip: sourceDb (the media), volume, levelDb (what plays), loudestFrameDb (the loudest 20 ms frame as RMS — a sample peak sits higher, so it is no clipping margin), and for every clip except the target, volumeToMatch: the volume that lands it at the target's level; a clip whose source has no audio track comes back with noAudio instead of levels. \"Make the voiceover as loud as the clip\", \"match the levels\", \"balance the music under the speech\": call this with every clip involved and target_id = the one to match, then set_clip_volume / update_audio with volumeToMatch (for a bed under speech, a fraction of it). A shortfallDb means the volume ceiling (3) cannot reach the target; lower the target instead. A clip marked muted plays nothing until set_clip_muted / update_audio unmutes it; its level is what it would play unmuted.",
    inputSchema: obj(
      {
        ids: { type: "array", items: { type: "string" }, description: "Clip ids to measure — video clips (their own sound) and soundtrack clips alike" },
        target_id: str("The clip whose level the others should match (default: the first id)"),
      },
      ["ids"]
    ),
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
      "Listen with your own ears to a project asset's sound — an audio asset, or the audio track of a video (its speech, music, burned-in narration) — so you can answer what it says or how it sounds. For the WORDS alone, check the source's transcript first: media entries marked speech: 'transcribed' carry timed segments (get_state includes them) at no audio cost; listen when you need the sound itself — tone, music, delivery, timing by ear. The sound rides back inline under a byte cap, so the seconds one call carries depend on the source — a stretch too long comes back as its opening, and `coveredTo` says where it stopped. Coverage works like watching's: `unheardSeconds` is how much of the source nobody has played and `unheardFrom` is where the next listen starts, both persisted on the asset, so judging how a whole source sounds means listening on from `unheardFrom` until `unheardSeconds` is 0. Pass clip_id for a timeline clip's source (scopes to its trim) or asset_id for the whole source; add from/to (source seconds) to hear one stretch of a long file. Write what you heard down with note_source — the audio leaves this conversation as it grows, the note stays on the source. Audio the user attached to their message already plays in it. To WRITE a caption track, use subtitles_generate.",
    inputSchema: obj({
      clip_id: str("Clip id — video or soundtrack (defaults from/to to its trimmed in/out)"),
      asset_id: str("Project asset id (audio or video) — listen to the whole source"),
      from: num("Source start s (default: the clip's in, else 0)"),
      to: num("Source end s (default: the clip's out, else the source's end)"),
    }),
  },
  {
    name: "compare_to_source",
    description:
      "Check the cut against the thing it was built from: renders your frame at each moment and reads the source's frame at the moment it stands for, handing both back side by side in one picture. This is how a replica is verified — watching the source tells you what it does, and this tells you whether what you made does it too. Pass `times` as timeline seconds, or as {at, source} pairs when the cut sits at a different second than the source does. Up to 4 moments a call; check, fix what is off, call again.",
    inputSchema: obj(
      {
        asset_id: str("Project asset id of the source the cut was built from"),
        times: {
          type: "array",
          description: "Moments to check — a timeline second, or {at, source} when the two clocks differ",
          items: {
            anyOf: [
              { type: "number" },
              obj({ at: num("Timeline second"), source: num("The second of the source it stands for") }, ["at"]),
            ],
          },
        },
      },
      ["asset_id", "times"]
    ),
  },
  {
    name: "find_highlights",
    description:
      "Find the moments in a long source worth cutting a short from, best first. Reads what is SAID over the source — its transcript, or the project's caption cues where they cover it — and ranks every stretch of it on three things: whether it stands on its own to someone who lands on it cold, whether its opening holds them, and whether it finishes the thought. A talk or an interview holds a handful of these and an hour of material that only makes sense in place; this is how the handful is found without watching all of it. Each result is one or more spans in SOURCE seconds with the words over them — two spans means two moments that belong together with the middle cut out, and `add_clip` with `spans` lays that down as one run of clips. The source needs a transcript: listen_audio starts one and it fills in behind you. Ranking reads the words alone, so a moment that reads well can still be someone glancing away — watch_video the spans before you commit to a look. Nothing is written to the timeline by this call.",
    inputSchema: obj({
      clip_id: str("Clip id — ranks the stretch its trim covers"),
      asset_id: str("Project asset id (video or audio) — ranks the whole source"),
      from: num("Source start s (default: the clip's in, else 0)"),
      to: num("Source end s (default: the clip's out, else the source's end)"),
      count: num("How many moments to return, 1..20 (default 5)"),
    }),
  },
  {
    name: "wait_for_renders",
    description:
      "Block until this project's in-flight video renders settle (up to ~100s), then report each one: landed (with its asset id, ready to place) or failed (with the error). Call it whenever the user's ask depends on a render that `renders` in the state shows as running — \"add it when it's done\", \"assemble the clips\" — and then finish the job in the same turn; never tell the user to come back and report when a card appears. If some renders are still running when it returns, say how long they've been going and call it again on the user's go-ahead.",
    inputSchema: obj({}),
  },
  {
    name: "queue_message",
    description:
      "Put a message on the composer queue to run as its own turn after this one finishes, with a fresh view of the project. For a further message the user sent while you were working that you cannot do yet: it needs this turn's finished result (an export, a share, a thumbnail of the final cut), or a fresh look at the timeline once your cuts have landed. Pass the user's words as they wrote them; the row goes out on its own when this turn settles, and your reply says what waits. The ask you were given is never queued — do it now.",
    inputSchema: obj({ text: str("The message, in the user's words") }, ["text"]),
  },
  {
    name: "import_url",
    description:
      "Read any URL — TikTok, YouTube, Instagram Reels, an X/Twitter post or Article, an ordinary web page, or a direct video/audio/image link — with the bundled downloader and import what it holds into the project. Free and local. A web page comes back as its article text plus the pictures on it; a post as its video or photos; and the source's own words (returned as sourceText) are quoted for the user beside the media automatically — don't retype them in your reply. A source that is only words returns sourceText with no assets, which is a success: read it and answer from it. This is how you look something up: point it at the page and read what comes back. When the user wants only the sound — a song, a soundtrack, a podcast — pass audio_only and the source's audio track lands as an audio asset. Media lands on a card in this chat and the user drags it to the timeline, Media, or the Library; place it yourself (add_clip) only when they asked for it in the cut. A short clip downloads in seconds; a long video can take a couple of minutes.",
    inputSchema: obj(
      {
        url: str("The page or media URL to download"),
        audio_only: bool(
          "Import only the source's audio track, extracted to an audio file (default false)"
        ),
      },
      ["url"]
    ),
  },
  {
    name: "read_project",
    description:
      "Read another Donkey Cut project as a reference: its whole edit in the same shape as <editor_state> — every clip with its trims, speed, framing, grade, look, mask, keyframes and animations; the transition bars; titles, shapes and stickers with their keyframes; the soundtrack; the caption look and cues; aspect and background — plus each source's observed notes, transcript and asset id. Takes a project link (…/app/p/<id>), a share link (…/s/<token>), or a project id. The document IS the edit: never watch_video a reference to learn what its document already states; watch a reference source (project_link) only to see footage its notes leave dark. Every item carries its id, so replicate_project can bring the whole edit or just the items the user wants — a title, one clip's treatment, the music — and copy_project_media can bring files over on their own. Nothing in the open project changes.",
    inputSchema: obj({ link: str("Project link, share link, or project id") }, ["link"]),
  },
  {
    name: "replicate_project",
    description:
      "Rebuild a reference project's edit in this project, once: the whole thing, or only `items` (ids from read_project — clips on any track, soundtrack clips, titles/shapes/stickers, cues, transition bars; a chosen clip brings the bars playing on it). Clips and layers land after the current end of track 0; free-standing items (a title alone, a music clip) drop in at the playhead, timed from the earliest of them. `media` maps the reference's source asset ids to this project's asset ids playing the same role (video for video or a still, audio for audio); every reference source the chosen items use and you did not map — music, stickers, images, fonts, and any footage you left unmapped — is copied from the reference into this project. Trims clamp to each mapped source's real length and every clamp is listed in `adjustments`: fix or report each one. With the whole edit, the reference's frame (aspect, background) and caption look come too; with `items` they come only when frame / caption_look are true. Caption cues copy with the whole edit only when captions is true (this project's speech differs, so generate them after); with `items`, name the cue ids. Background removal on a reference clip stays behind. One undo step reverts every item and the caption look; the frame is a project setting, so set_aspect / set_background put it back. Afterwards tune with the ordinary tools.",
    inputSchema: obj(
      {
        link: str("The same link read_project took"),
        items: {
          type: "array",
          items: { type: "string" },
          description: "Reference item ids to bring across (absent = the whole edit)",
        },
        media: {
          type: "array",
          description: "Role mapping, reference source → this project's asset",
          items: obj(
            {
              source_asset_id: str("Reference asset id (from read_project's media)"),
              asset_id: str("This project's asset id that plays that role"),
            },
            ["source_asset_id", "asset_id"]
          ),
        },
        frame: bool("Also set this project's aspect and background to the reference's (default: true for the whole edit, false with items)"),
        caption_look: bool("Also apply the reference's caption look — style, font, size, position, words per cue, word effects (default: true for the whole edit, false with items)"),
        captions: bool("With the whole edit, also copy the reference's caption cues (default false)"),
      },
      ["link"]
    ),
  },
  {
    name: "copy_project_media",
    description:
      "Copy files from a reference project into this one without placing anything: a music track, a sticker, a photo, a clip the user wants to reuse. Takes the reference's asset ids from read_project. Each copy keeps its notes, transcript and beat grid, lands on a card in this chat, and is a project asset from then on — add_clip places it when the user asks for it in the cut.",
    inputSchema: obj(
      {
        link: str("The reference project's link or id"),
        asset_ids: { type: "array", items: { type: "string" }, description: "Reference asset ids to copy" },
      },
      ["link", "asset_ids"]
    ),
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
