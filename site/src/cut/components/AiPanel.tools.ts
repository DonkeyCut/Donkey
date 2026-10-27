/**
 * The assistant's own tools — its senses on the project (state snapshot,
 * watching footage, listening, silence detection), the chat-driven fetch and
 * wait flows, and the server-handled skills library — kept beside the chat
 * panel that exposes the assistant. The catalog spreads this list into the
 * model's toolset and `aiTools.ts` keys its handlers on `AiPanelToolName`
 * (the `server: true` tools run in the engine and take no browser handler).
 */

import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
import { TIMELINE_IDS, WATCH_DETAIL_NOTES, WATCH_DETAILS } from "@/cut/lib/types";
import { FACT_CLAIM_MAX_CHARS, FACT_CLAIMS_MAX } from "@/lib/inference/factCheck";
import { URL_BATCH_MAX } from "@/cut/lib/urlBatch";
import { PROJECT_PAGE_DEFAULT, PROJECT_PAGE_MAX } from "@/cut/lib/projectLink";
import { FIND_MEDIA_DEFAULT, FIND_MEDIA_MAX, FIND_MEDIA_SNAPSHOT_CAP } from "@/cut/lib/findMedia";
import { COMPARE_MODES, MAX_COMPARE, SWEEP_TARGET } from "@/cut/lib/frameDiff";
import { EASE_IDS } from "@donkeycut/effects-kit";
import { LOCALES, type Locale } from "@/i18n/locales";
import {
  DETECT_CHANGES_MAX,
  DETECT_CUTS_MAX,
  DETECT_CUTS_SPAN_MAX,
  SAMPLE_COLOR_MAX,
  SAMPLE_COLORS_K_MAX,
  TRACK_FRAMES_MAX,
  CAMERA_FRAMES_MAX,
  TRACK_MATCHES,
  TRACK_TOLERANCE_DEFAULT,
} from "@/cut/lib/measure/limits";

/** A box on a source's frame as the editor places one: centre and size. */
const frameBox = (what: string) => ({
  ...obj(
    {
      x: num("Centre x, fraction of frame width"),
      y: num("Centre y, fraction of frame height"),
      w: num("Width, fraction of frame width"),
      h: num("Height, fraction of frame height"),
    },
    ["x", "y", "w", "h"]
  ),
  description: what,
});

/** The part of a source's frame the source-reading tools read. */
const pictureArg = {
  anyOf: [
    { type: "string", enum: ["full"] },
    obj(
      {
        x: num("Centre x, fraction of the whole frame's width"),
        y: num("Centre y, fraction of the whole frame's height"),
        w: num("Width, fraction of the whole frame's width"),
        h: num("Height, fraction of the whole frame's height"),
      },
      ["x", "y", "w", "h"]
    ),
  ],
  description:
    'Read inside this box of the source\'s frame, or "full" for the whole frame. Default: the picture box find_picture keeps on the source, else the whole frame. Every x, y, w, h the call takes and returns is a fraction of it.',
};

/** A locale's language by its English name, the way the model reads it:
 * "ko" → "Korean", "pt-BR" → "Brazilian Portuguese". */
export function languageName(locale: Locale): string {
  return new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale;
}

/** The interface languages, as the prompt and set_interface_language list
 * them: "en (English), es (Spanish), …". */
export const INTERFACE_LANGUAGE_LIST = LOCALES.map((locale) => `${locale} (${languageName(locale)})`).join(", ");

export const AI_PANEL_TOOLS = [
  {
    name: "get_state",
    description:
      "Read the full current editor state: clips, soundtrack, overlay elements (titles, shapes, stickers), subtitles, selection, playhead, view settings, publish metadata. Use this whenever the context snapshot is not enough or might be stale. A big cut read whole can run past what a result carries: name the sections you need (soundtrack, overlays, videoTrack, overlayVideo, transitions, subtitles, media, project, …) to check an edit.",
    inputSchema: obj({
      sections: { type: "array", items: { type: "string" }, description: "Top-level sections to return (the playhead always rides along); omit for everything" },
      timeline: { type: "string", enum: [...TIMELINE_IDS], description: "Read another timeline's items (videoTrack, soundtrack, overlays, …) without opening it; omit for the open one" },
    }),
  },
  {
    name: "get_asset_info",
    description:
      "Read a project asset's file name, kind, readable fileSize (KB, MB, GB), exact sizeBytes, duration in seconds, and pixel dimensions. Present fileSize in replies; include exact bytes only when asked. Use this for file-size questions when sizeBytes is absent from the media snapshot. Reads file metadata across browser, Mac, and cloud storage.",
    inputSchema: obj({ asset_id: str("Project asset id from media or an import result") }, ["asset_id"]),
  },
  {
    name: "find_media",
    description:
      `Find project media by name: every asset whose name or file name contains query (any case), optionally of one kind, with its id. The context snapshot lists at most ${FIND_MEDIA_SNAPSHOT_CAP} media items (mediaTruncated says when it cut the rest), so use this to reach the others — say the reference images a person just uploaded to a long project. Pages: pass the answer's next as offset for more. Matches another chat thread made and hasn't placed are hidden from this chat; heldByOtherChats counts them, so never call such a file missing.`,
    inputSchema: obj({
      query: str("Text the name or file name contains (omit for all)"),
      type: { type: "string", enum: ["video", "image", "audio"], description: "Only this kind of media" },
      limit: num(`How many to return, 1..${FIND_MEDIA_MAX} (default ${FIND_MEDIA_DEFAULT})`),
      offset: num("Skip this many matches (the previous answer's next)"),
    }, []),
  },
  {
    name: "watch_video",
    description:
      "Watch a video source with your own eyes: samples candidate frames on a dense steady floor plus one just after each line the source speaks — what a video shows changes when what it says changes, so a transcribed source is read on its own clock and a caption track lands a frame per card — keeps only the ones that actually differ, and tiles them into timestamped contact-sheet images — so every cell is a distinct moment and a gap between stamps means nothing changed there. Also returns sceneChanges, hard-cut times on the first frame of the new shot, to the millisecond — though a shot shorter than the sampling step can fall between candidates, so where every cut matters, detect_cuts reads every frame. When the clip has captions or the source's own transcript exists, a fused timeline places each kept frame inside the speech it belongs to. Pass clip_id to watch a timeline clip's source (the result includes that clip's source↔timeline time math) or asset_id for any project video or image. `detail` decides how many pixels each kept frame is worth: scan tiles many small cells for coverage, read enlarges them for on-screen text, original hands back the source's own frames for matching type, colour and edges. A contact-sheet cell is a quarter of the frame's width, so a small caption arrives too small to read — when the job is words on screen or a look to reproduce, spend the pixels instead of guessing. `textFits` comes back with the frames: the parts of the picture that stay quiet across everything just watched, inside whatever the project's guides keep clear, quietest first — where a title or caption can go without covering the subject or the source's own on-screen text. The stamp burned into each cell is SOURCE seconds — what trim_clip's in/out use — not timeline seconds. Coverage ends where the result says it does: `coveredTo` is how far you have looked and `unwatchedSeconds` is how much of the source you have NOT — everything before coveredTo was seen, nothing after it was. Reading is measured apart from seeing: `unreadSeconds` is how much of the source no pass has looked at closely enough to read its type, and `unreadFrom` is where the next close pass starts. Both ride the asset, so they carry what every earlier chat read as well as this one. Continue from coveredTo until unwatchedSeconds is 0 before you describe, summarize, or reproduce the source as a whole; a `to` you chose yourself ends a call with truncated false and the rest of the video still unseen. Watching builds the source's frame map (moment times + cut candidates), persisted on the asset; media entries list those spans as `mapped`, and your first watch starts a quiet background sweep that maps the rest (`watching: true` while it runs). The map aims your watches — a mapped span is NOT footage you have seen; only sheets returned in this conversation are, so watch any span you need to actually look at. Every pass ends with note_source: the sheets are conversation-local and drop out as the chat grows, so write what this stretch showed against its source seconds and it stays on the asset for every later turn. The result carries `recorded` (what is already written about the stretch you just watched) and `unnoted` (the spans of this source nothing describes yet); watching a source that still owes a note is refused. Read the watching-and-cutting skill before editing footage by content.",
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
      "Measure how loud clips actually play — the level of each clip's audible sound over its trimmed range, in dBFS, with its current volume applied — so volumes are set from numbers. Returns per clip: sourceDb (the media), volume, levelDb (what plays), loudestFrameDb (the loudest 20 ms frame as RMS — a sample peak sits higher; read clipping margin from samplePeakDb), loudestAt / loudestAtTimeline (when the loudest single sample plays, in source and timeline seconds, to the millisecond — put a click, hit or drop on a beat with these) and samplePeakDb, and for every clip except the target, volumeToMatch: the volume that lands it at the target's level; a clip whose source has no audio track comes back with noAudio and no levels. \"Make the voiceover as loud as the clip\", \"match the levels\", \"balance the music under the speech\": call this with every clip involved and target_id = the one to match, then set_clip_volume / update_audio with volumeToMatch (for a bed under speech, a fraction of it). A shortfallDb means the volume ceiling (3) cannot reach the target; lower the target instead. A clip marked muted plays nothing until set_clip_muted / update_audio unmutes it; its level is what it would play unmuted. Each clip also reports integratedLufs (BS.1770 loudness over its range) and truePeakDbtp, both as it plays with its volume applied; a volume change of g dB moves both by g (volume × 10^(g/20)), so \"music 10 LU under the voice\" is a volume that puts the music's integratedLufs 10 below the voice's. mix: true measures the whole mix as an unmastered export hears it: integratedLufs, truePeakDbtp, loudnessRangeLu and maxShortTermLufs — check it against the export's loudness targets or a platform's spec. null means silence.",
    inputSchema: obj({
      ids: { type: "array", items: { type: "string" }, description: "Clip ids to measure — video clips (their own sound) and soundtrack clips alike; optional with mix" },
      target_id: str("The clip whose level the others should match (default: the first id)"),
      mix: bool("Also measure the whole mix's loudness and true peak (default false)"),
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
      "Check the cut against the thing it was built from, in numbers and in pictures. Every frame is scored by `diff`: the mean difference per pixel between your frame and the source's, 0 (the same) to 255, read at one small size so a score means the same thing in every call; under " +
      `${SWEEP_TARGET} reads as the same picture. ` +
      "mode sweep scores every step of the cut (or from/to) with no pictures and returns the median, p95 and max with the worst stretches, each with its peak frame and a 4×4 grid of where in the frame it differs, and `edges`: stretches whose difference runs along whole edges of the frame while the middle matches — a border, band or letterbox — listed under target too, since thin bars barely move the mean. The picture box is already cut out of any app or bars around it, so a band inside it is part of the picture: build it, with shapes or a smaller block. " +
      "`titles` names each title whose letters read another colour than the source's under it (`ink` yours, `sourceInk` the source's, read at the title's middle), which a frame score at this size barely moves for. " +
      "A decoder that fails mid-read is replaced and the read goes on: `lost` names source frames no decoder read, and a source that stops decoding ends the sweep at `coveredTo` with `stopped` saying where and why. " +
      `mode moments (the default) takes up to ${MAX_COMPARE} \`times\` and hands back each as the source's frame and yours side by side, with its score and grid. ` +
      "Either mode says when a frame matches the source better a few frames away: `shift` is that distance, and a positive one means move what is there later by that much. " +
      "This is how a replica is verified. The loop: sweep, look at the peaks of the worst stretches and the edges in moments mode, fix what differs, sweep again — until the median is under " +
      `${SWEEP_TARGET} and no stretch in worst or edges stands out. ` +
      "Blocks standing in for footage keep a difference no edit removes, so read those by the grid cells over your titles and shapes. " +
      "Pass `times` as timeline seconds, or {at, source} pairs when the cut sits at a different second than the source does; `offset` maps every bare second and the whole sweep (source second = timeline second + offset). " +
      "Only the source's picture box is held against your frame (find_picture), so a reference recorded inside an app scores its picture alone.",
    inputSchema: obj(
      {
        asset_id: str("Project asset id of the source the cut was built from"),
        mode: { type: "string", enum: [...COMPARE_MODES], description: "moments: pictures and scores at `times` (default); sweep: scores over a span, no pictures" },
        times: {
          type: "array",
          description: `moments: up to ${MAX_COMPARE} moments to check — a timeline second, or {at, source} when the two clocks differ`,
          items: {
            anyOf: [
              { type: "number" },
              obj({ at: num("Timeline second"), source: num("The second of the source it stands for") }, ["at"]),
            ],
          },
        },
        offset: num("Source second minus timeline second, for every moment without its own source and for the sweep (default 0)"),
        from: num("sweep: timeline second to start at (default 0)"),
        to: num("sweep: timeline second to stop at (default the cut's end)"),
        step: num("sweep: seconds between samples (default one frame, widened so a long span fits the call)"),
        fit: {
          type: "string",
          enum: ["letterbox", "fill"],
          description:
            "How a source of another shape sits in the cut's frame to be scored. letterbox (the default): whole, over the background, the way a clip of that shape sits on the timeline. fill: scaled to cover the frame and centre-cropped, for a copy that fills its own frame edge to edge in another shape — what the crop cuts off is not checked, and type and shapes read at the fill's scale",
        },
        picture: pictureArg,
      },
      ["asset_id"]
    ),
  },
  {
    name: "find_picture",
    description:
      "Find where a video's picture sits inside its frame: the part that changes over time, apart from letterbox bars or the app a screen recording shows it in — a phone recording of an editing app has its picture across the middle, with buttons and a timeline around it. Reads frames spread over the source (or from/to) and returns `picture`, the box as centre and size in frame fractions, its `aspect`, and `active`, the share of the box that moved. The box is kept on the source: detect_cuts, sample_color, track_element, suggest_font and compare_to_source read inside it from then on, and the x, y, w, h they take and return are fractions of it, so they land on the cut's frame as they are. detect_cuts finds it on its first read of a source. Pass `box` to set it yourself, or \"full\" for the whole frame, when the one found is off.",
    inputSchema: obj(
      {
        asset_id: str("Project asset id of the video (or image, with box)"),
        from: num("Source start s to read frames from (default 0)"),
        to: num("Source end s (default the source's end)"),
        box: {
          anyOf: [{ type: "string", enum: ["full"] }, frameBox("The picture's box")],
          description: 'Set the picture box yourself: centre and size as frame fractions, or "full" for the whole frame',
        },
      },
      ["asset_id"]
    ),
  },
  {
    name: "detect_cuts",
    description:
      `Find every hard cut in a stretch of a video source, to the frame. Reads every frame between from and to at a few dozen pixels, scores how much of the picture changed since the frame before, and reports each frame that opens a new shot: \`t\` in SOURCE seconds to the millisecond (the new shot's first frame), its \`frame\` index at the source's \`fps\`, and \`change\`, the percent of the picture that changed — near 100 is a new shot, 10-30 a card or a block of type swapping over the same background. A flat colour cut to a near one counts. \`shots\` lists the stretches between the cuts with their length in frames. \`changes\` lists what changes inside a shot over a picture that stays: a word appearing, a word swapping fill for outline, a shape popping in, a face switching — each its first frame (\`t\`, \`frame\`), how many frames it runs (a fade-in runs several), its \`change\` in percent and its \`box\`. A change marked \`flicker\` flips back and forth frame by frame over its run — a strobe, a cutout flashing to its negative — so every frame of it differs from the one before and returns to a look two or three frames old; read its frames one at a time. A fade too faint for any one frame to show — small type easing in or out over half a second — still counts: its \`frame\` is the first step it takes and \`frames\` runs to where it settles, so a title's fade in, fade out and their lengths come from here. Time titles, their fades, outline swaps, shape pops and font_cycle_switches from these. watch_video lands a frame in every shot and change this reads, so read type after this pass. watch_video's sceneChanges come from samples a step apart and lose a shot shorter than the step; this reads every frame, so a five-frame shot in a fast montage is found. Run it before blocking out a reference: add_clip \`blocks\` takes one block per shot at that shot's length. Hard cuts only — a dissolve or a fade between two shots changes a little each frame and reads as no cut. A fade of the whole picture into black or white, or out of it, is listed in \`fades\`: its start \`t\`, \`seconds\`, \`fade\` (to or from), \`tone\`, how far it goes (\`amount\`) and the curve it runs along (\`ease\`), each fitted to every frame — exactly what add_effect flash takes, so a fade to black over the end is set from here, never from sampled colours. Up to ${DETECT_CUTS_SPAN_MAX}s, ${DETECT_CUTS_MAX} cuts and ${DETECT_CHANGES_MAX} changes a call; when \`truncated\`, call again from \`coveredTo\`. A source with no picture box yet has it found first (find_picture) and kept, and every frame is read inside it, so a card that changes a small part of a recorded frame still counts as the change to the picture it is.`,
    inputSchema: obj(
      {
        asset_id: str("Project asset id of the video"),
        from: num("Source start s (default 0)"),
        to: num(`Source end s (default the source's end, at most ${DETECT_CUTS_SPAN_MAX}s past from)`),
        picture: pictureArg,
      },
      ["asset_id"]
    ),
  },
  {
    name: "sample_color",
    description:
      `Read the colour of a source's pixels: the hex of a region or a point of a frame at a source second, so a block, a shape, a title or a background takes the reference's colour as a number. Contact-sheet cells are JPEGs and shift colour; this reads the decoded frame as the preview shows it. Each sample is a moment \`t\` (SOURCE seconds) and a box — x/y its centre and w/h its size as frame fractions, the box add_shape takes; leave out w/h to read a point. Returns per sample \`hex\`, the region's median colour, and \`spread\`, how far its pixels stray from it on average (0-255: under 10 is a flat fill, over 40 a mix — read \`dominant\` there). \`colors\` 2-${SAMPLE_COLORS_K_MAX} adds \`dominant\`, the colours the region is made of with their shares, largest first: a card and the type on it, a bar and the shot behind it. Read a point inside a flat fill for its colour, a box over a title for its ink and its ground; the ink's share tells a filled word (a quarter of its box or more) from an outlined one, so a word that swaps between the two is read shot by shot. Up to ${SAMPLE_COLOR_MAX} samples a call, at one moment or each at its own. Works on a still image too (t is ignored).`,
    inputSchema: obj(
      {
        asset_id: str("Project asset id (video or image)"),
        samples: {
          type: "array",
          description: `Up to ${SAMPLE_COLOR_MAX} regions to read`,
          items: obj(
            {
              t: num("Source second"),
              x: num("Centre x, fraction of frame width"),
              y: num("Centre y, fraction of frame height"),
              w: num("Width, fraction of frame width (omit with h for a point)"),
              h: num("Height, fraction of frame height"),
            },
            ["x", "y"]
          ),
        },
        colors: num(`Also list this many dominant colours per region, 2..${SAMPLE_COLORS_K_MAX} (default: none)`),
        picture: pictureArg,
      },
      ["asset_id", "samples"]
    ),
  },
  {
    name: "track_element",
    description:
      `Measure where an element of a source's picture sits, frame by frame, and how it moves, so a grow, a slide or a pop is keyed with set_overlay_keyframes to the reference's own numbers. Give a stretch of a video (SOURCE seconds) and a \`seed\` box on the element at \`from\`; boxes in and out are x/y centre and w/h size as frame fractions — what add_shape, add_title and the keys take. The element is found by colour: \`color\` (sample_color reads it), or else the seed's median colour on the first frame, so draw the seed inside the element's edges at a moment it is on screen. \`match\` shape follows the one connected piece of that colour the seed sits on — a card, a bar, a sticker — as it moves and changes size; ink takes every pixel of that colour inside the seed (or \`within\`), the ink of a line of type whose letters are separate pieces: its centre is where the title sits and its height is about 0.7 of the font size when the line is capitals. letters reads a line of type coming in letter by letter — a drop, a rise, a fall out of focus: give \`text\` (the words as they read), \`to\` a moment just after the last letter lands, \`from\` before the first one shows, and a seed close around the landed line; it returns each letter's timing (shows, starts, lands, alpha, soft — the defocus it shows in at) and \`entrance\`, the whole entrance as set_overlay_animation takes it, plus \`crosses\`, other ink the letters pass in front of or behind, which says which lane goes in front. Leave out \`to\` to measure one frame. \`moves\` lists each move of x, y, w and h with from/to (the source seconds it starts and lands), start/end values, the ease that fits it (${EASE_IDS.join(", ")}) and \`error\`, the RMS miss as a share of the move: under 0.03 is that curve, over 0.1 none fits and the move keys from \`path\` point by point. A size move keys as scale: w over the element's resting w. \`path\` lists the box wherever it changes (a hold is one entry); a null box is a frame where the element was not found. Up to ${TRACK_FRAMES_MAX} frames a call; when \`truncated\`, continue from \`coveredTo\`. Works on a still image too (one frame).`,
    inputSchema: obj(
      {
        asset_id: str("Project asset id (video or image)"),
        from: num("Source second the seed shows the element at"),
        to: num("Source end s; omit to measure the one frame at from"),
        seed: frameBox("A box on the element at from — inside its edges for shape, around the line for ink"),
        within: frameBox("Only look inside this box (default: the whole frame for shape, the seed for ink)"),
        color: str("The element's colour as #RRGGBB (default: the seed's median colour; for letters, the seed's main colour other than its ground)"),
        text: str("letters: the line's words exactly as they read once every letter has landed"),
        tolerance: num(`Per-channel distance from color that still counts as it, 0..255 (default ${TRACK_TOLERANCE_DEFAULT}); raise it for a gradient or a soft edge`),
        match: {
          type: "string",
          enum: [...TRACK_MATCHES],
          description:
            "shape: the one connected piece the seed sits on (default). ink: every pixel of the colour inside the seed or within — type. letters: a line of type coming in letter by letter, read as one per-letter entrance (needs text and to)",
        },
        picture: pictureArg,
      },
      ["asset_id", "from", "seed"]
    ),
  },
  {
    name: "track_camera",
    description:
      `Measure how the camera moves over a stretch of a video, inside its picture: each frame's zoom, shift and turn against the frame on \`from\`, so a punch-in, a push, a beat zoom pulse or a shake is keyed with set_clip_keyframes to the reference's own numbers. Give one shot's stretch (SOURCE seconds; a cut inside it breaks the read). \`path\` lists every frame: t, scale (1.08 is 8% closer), dx/dy (how far the picture's centre moved, fractions of the frame, + is right and down), rotation (degrees clockwise) and residual (what the move leaves unexplained, 0..255 a pixel; null on a frame too blurred to read). A frame whose picture moves in two layers — a cutout held still over a background that shakes, or pulsing over a still one — also has \`second\`, the other layer's pose and the \`share\` of the picture it holds: build it as two tracks, the footage keyed with one pose and its cutout (set_removal) above it keyed with the other. The keys copy it straight across: a clip key at the same moment with scale, rotation, and x = 0.5 + dx, y = 0.5 + dy — relative to the first frame, so start the clip's own pose there. \`moves\` lists each move of each number with from/to, start/end, the ease that fits it (${EASE_IDS.join(", ")}) and \`error\`; a pulse is a move out and a move back. \`still\` true means one picture holds under the whole move — residual under 6 throughout: the reference froze that frame and moved it, so freeze_frame the shot's clip at \`from\` and key the moves on the freeze. A live shot with a moving camera leaves a higher residual: its numbers are still the move. Up to ${CAMERA_FRAMES_MAX} frames a call; when \`truncated\`, continue from \`coveredTo\`.`,
    inputSchema: obj(
      {
        asset_id: str("Project asset id (video)"),
        from: num("Source second the stretch starts: the frame every other is measured against"),
        to: num("Source second it ends, inside the same shot"),
        picture: pictureArg,
      },
      ["asset_id", "from", "to"]
    ),
  },
  {
    name: "suggest_font",
    description:
      "Name the face a reference's type is set in: reads the source's frame at t, lifts the ink inside region off its ground, and ranks every face Donkey can set a title in — each bundled family at each bundled weight, the system set and the account's own fonts — by how closely its glyphs for the same words match, tracking solved so each runs as wide as the reference. Call it for each distinct face while rebuilding a reference's titles, so the font, weight, size and tracking come from the frame. Pass the words exactly as they read, case and line breaks included, and a region close around them read off watch_video at detail original. Returns the best faces with score (0..1), size (px at the 1080 short side, for the same ink height) and tracking (em), and x/y, where that face's title sits (add_title's x/y) for its ink to land on the reference's — a title is set from the middle of its line, so its ink centre is off it. `ink` is the ink's own box, centre and size in frame fractions. Cards in one face share its weight, size and tracking, but each sits its own way in its space, so read each card for its own x/y rather than setting the rest from the first one's place. Type set at an angle — a column word reading bottom to top — is read upright: pass `rotation`, the angle add_title would set it at (-90 reads bottom to top, 90 top to bottom), with a region around the word as it stands; one line of words in a region taller than wide is tried both ways round without it, and `rotation` comes back with the result to set on the title. verdict no_match means nothing bundled is close: the reference uses a face Donkey does not bundle, so say so and name the stand-in you use, of its kind — `kinds` lists every face by kind (serif, sans, script, display, mono), each as its id and a few words on its look. `inkPx` is how tall a line of the ink runs in the source; under 24 the result is `small`: the glyphs have blurred into their proportions, the ranking cannot tell a serif from a condensed sans, so name the face by eye at detail original and take the closest of its kind from `kinds`.",
    inputSchema: obj(
      {
        asset_id: str("Project asset id of the reference (video or image)"),
        t: num("Source second the type shows at (default 0)"),
        region: obj(
          {
            x: num("Centre x, frame fraction"),
            y: num("Centre y, frame fraction"),
            w: num("Width, frame fraction"),
            h: num("Height, frame fraction"),
          },
          ["x", "y", "w", "h"]
        ),
        text: str("The words the region shows, as they read, with a line break where the type breaks"),
        rotation: num("Degrees the type is turned, as add_title's rotation: -90 reads bottom to top, 90 top to bottom (default: upright, or both ways for one line in a tall region)"),
        count: num("How many faces to return, 1..10 (default 5)"),
        picture: pictureArg,
      },
      ["asset_id", "region", "text"]
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
    name: "wait_for_uploads",
    description:
      "Block until this project's files finish uploading and the browser has a connection (up to ~100s), retrying uploads that failed, then report each one: done, failed with the error, or still uploading with its percent. A file still uploading (`upload` on its media entry) already plays and reads from this browser, so editing, watching and listening go ahead without waiting; wait when the ask needs the stored copy (a render or export in the cloud, a share) or when `offline` is set or a call failed on the connection. Then run what waited, in the same turn.",
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
      "Read a web or media URL. For Donkey folder links use read_folder; for Donkey project links use read_project. Supports TikTok, YouTube, Instagram Reels, an X/Twitter post or Article, an ordinary web page, a Pexels video page (pexels.com/video/<slug>-<id>/ — it comes down as its 1080p file, named with its Pexels id) or one of its files (videos.pexels.com/video-files/<id>/…), or a direct video/audio/image link — with the bundled downloader and import what it holds into the project. Free and local. A web page comes back as its article text plus the pictures on it; a post as its video or photos; and the source's own words (returned as sourceText) are quoted for the user beside the media automatically — don't retype them in your reply. A source that is only words returns sourceText with no assets, which is a success: read it and answer from it. This is how you look something up: point it at the page and read what comes back. When the user wants only the sound — a song, a soundtrack, a podcast — pass audio_only and the source's audio track lands as an audio asset. Media lands on a card in this chat and the user drags it to the timeline, Media, or the Library; place it yourself (add_clip) only when they asked for it in the cut. A short clip downloads in seconds; a long video can take a couple of minutes.",
    inputSchema: obj(
      {
        url: str("The page or media URL to download"),
        urls: {
          type: "array",
          items: { type: "string" },
          maxItems: URL_BATCH_MAX,
          description: `Several direct media links at once (up to ${URL_BATCH_MAX}), in place of url — a section's stock footage, say. They download two at a time and come back as results in the order given, each with its assets or its own error, so one dead link never fails the rest. A call answers within about 90s: a link still downloading then comes back pending (it lands in the project on its own — don't import it again; it shows up in media) and links it never reached come back in notStarted — call again with exactly those. Pass every link in one call`,
        },
        audio_only: bool(
          "Import only the source's audio track, extracted to an audio file (default false)"
        ),
      },
      []
    ),
  },
  {
    name: "check_facts",
    description:
      "Check factual claims against the web: each claim is searched on Google and comes back with a verdict (supported, contradicted, mixed, or unverifiable), the corrected value when the claim is wrong, a one-line note on what the sources say, and the pages the search found, each with its title and URL. A verdict needs several sources behind it, so a claim the search barely covers comes back unverifiable and says how many it found. Check every figure the narration or a title states — a number, a date, a price, a name, a release — before you show it on screen, passing each as its own specific claim worded the way the video says it. Report every contradicted, mixed or unverifiable claim to the user plainly, with what the sources say and where; change their words only when they ask. Sources come only from the search, so quote them as given. Spends credits: one web search per claim.",
    inputSchema: obj(
      {
        claims: {
          type: "array",
          items: { type: "string" },
          maxItems: FACT_CLAIMS_MAX,
          description: `The specific statements to check, one fact each, under ${FACT_CLAIM_MAX_CHARS} characters; at most ${FACT_CLAIMS_MAX} per call`,
        },
        context: str("What the video is about, so an ambiguous claim is searched the way it is meant (optional)"),
      },
      ["claims"]
    ),
  },
  {
    name: "list_projects",
    description:
      "List the user's own Donkey Cut projects, newest edit first: each project's id, its current name, where it lives and when it was last edited, with the open project marked. Use it when the user or a note names another project by its title (\"copy the styles of the project named Graphics Ref\", \"the intro from my launch video\"): pick the project the name means, then pass its id to read_project. Names change; the id is what every project tool takes. A project attachment already carries its id, so it needs no lookup. `unreachable` names shelves this session could not read; a project the user names may live there, so say so.",
    inputSchema: obj({
      offset: num("Where the page starts; pass the previous page's next"),
      limit: num(`Projects per page, 1..${PROJECT_PAGE_MAX} (default ${PROJECT_PAGE_DEFAULT})`),
    }),
  },
  {
    name: "read_project",
    description:
      "Read another Donkey Cut project as a reference: its whole edit in the same shape as <editor_state> — every clip with its trims, speed, framing, grade, look, mask, keyframes and animations; the transition bars; titles, shapes and stickers with their keyframes; the soundtrack; the caption look and cues; aspect and background — plus each source's observed notes, transcript and asset id. Takes a project link (…/app/p/<id>), a share link (…/s/<token>), or a project id (a project the user names by title: its id from list_projects). The document IS the edit: never watch_video a reference to learn what its document already states; watch a reference source (project_link) only to see footage its notes leave dark. Every item carries its id, so replicate_project can bring the whole edit or just the items the user wants — a title, one clip's treatment, the music — and copy_project_media can bring files over on their own. Nothing in the open project changes.",
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
    name: "set_interface_language",
    description:
      `Change the language the editor's own interface shows — its menus, buttons and messages — for this account: ${INTERFACE_LANGUAGE_LIST}. Call it only when the person asks to change the interface language; a reply in another language needs no call. In the editor the change saves to the account and the page reloads in the new language as this reply finishes; a session with no editor page saves it to the account, and the editor opens in it next time. The result says which happened.`,
    inputSchema: obj(
      { locale: { type: "string", enum: [...LOCALES], description: "The interface language" } },
      ["locale"]
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
