/**
 * The Cut chat eval cases. Each case replays a real composer turn and asserts
 * on what the model does: questions get answered in chat without
 * project-mutating tool calls, edit requests still reach for tools.
 *
 * Every case carries a latency bucket:
 *   chat        — the fast path: gated greetings and question turns
 *   single-tool — one decisive call reaches the right tool
 *   multi-tool  — composed edits over several calls
 */

import { gradePresetsInCategory } from "@donkeycut/effects-kit";
import {
  AUDIO_STATE,
  CLIP_REFS,
  CROSSFADED_STATE,
  FILLER_STATE,
  makeSceneSim,
  makeTimelineSim,
  NARRATION_ASSET,
  PHOTO_ASSETS,
  PHOTO_REFS,
  SCENE_DONE_STATE,
  STYLED_STATE,
  PARKED_STATE,
  STRANDED_TITLE_STATE,
  TWEET_ASSET,
  TWEET_STATE,
  TWO_CLIP_STATE,
  type EvalMessage,
  assistantToolTurn,
  assistantTurn,
  plainUserTurn,
  userTurn,
} from "./fixtures";

export type Bucket = "chat" | "single-tool" | "multi-tool";

export interface EvalCase {
  name: string;
  /** Latency bucket the case aggregates under. */
  bucket: Bucket;
  input: () => EvalMessage[];
  /** The final reply must match. */
  reply: RegExp;
  /** Tools that MUST appear across the turn (each stubbed to succeed). */
  requiredTools?: string[];
  /** At least one of these must appear — for flows with several valid cuts. */
  anyTools?: string[];
  /** Latency guard: the turn fails if the trace exceeds this many calls. A
   * simple ask must not detour through skill reads or state polls. */
  maxToolCalls?: number;
  /** The gate side the turn must classify to: "chat" turns run with no tool
   * declarations (tool calls become impossible), "work" covers both routing
   * verdicts (simple and complex). */
  gate?: "chat" | "work";
  /** The turn is expected to end on a question (a genuinely ambiguous ask), so
   * the trailing-question shape check stands down. */
  expectsQuestion?: boolean;
  /** Round-budget overrides, for exercising auto-continue with a tiny budget. */
  limits?: { roundBudget?: number; maxExtensions?: number };
  /** Auto-continue extensions the turn must land in. */
  extensions?: { min?: number; max?: number };
  /** Debris lines the turn ledger reports (the live editor computes these from
   * the store; the eval injects them). */
  debris?: string[];
  /** Editor snapshot served to get_state for this case (default EDITOR_STATE). */
  state?: unknown;
  /** Per-run tool interceptor (fresh per run); a non-undefined return serves
   * the call before stubs and safe tools. */
  simulate?: () => (name: string, args: Record<string, unknown>) => unknown;
  /** Stub results for expected tool calls. */
  stubs?: Record<string, unknown>;
  /** Latency budgets checked against passing-run p50s by the latency eval;
   * report-only unless --enforce-budgets. Set from baseline numbers. */
  budget?: { totalMs?: number; ttftMs?: number; gateMs?: number };
}

export function cases(audio: { dataBase64: string; mimeType: string }): EvalCase[] {
  return [
    {
      // The regression from the screenshot: asking for an attached audio's
      // text must be answered from the inline audio — in chat, no captions
      // written onto the project.
      name: "transcribe-attached-audio",
      bucket: "chat",
      input: () => [userTurn("get the text from this", { attachAudio: audio })],
      reply: /mason/i,
    },
    {
      // The tool gate (the "hi" regression, which once fired an unsolicited
      // subtitles_generate): a bare greeting asks for nothing, so the turn
      // must classify "chat" and run with every tool declaration withheld.
      name: "greeting-is-gated",
      bucket: "chat",
      input: () => [userTurn("hi")],
      reply: /help|what would you/i,
      gate: "chat",
      maxToolCalls: 0,
      budget: { gateMs: 2000, ttftMs: 4500, totalMs: 5000 },
    },
    {
      // Same gate mid-conversation: thanks after landed work requests nothing.
      name: "thanks-is-gated",
      bucket: "chat",
      input: () => [
        plainUserTurn("trim the first clip down to 5 seconds"),
        assistantTurn("Trimmed! The first clip now runs 5 seconds."),
        userTurn("nice, thank you!"),
      ],
      reply: /\S/,
      gate: "chat",
      maxToolCalls: 0,
    },
    {
      // Context rides into the gate: a terse follow-up is a request — its
      // referent lives in the earlier turns — so it classifies "work" and the
      // caption cleanup actually lands.
      name: "follow-up-do-it-works",
      bucket: "multi-tool",
      input: () => [
        plainUserTurn("could you clean up my captions? lots of filler words"),
        assistantTurn(
          "Happy to — I'd tidy the five cues on track 0, dropping the ums and uhs. Want me to go ahead?"
        ),
        userTurn("yes do it", { state: FILLER_STATE }),
      ],
      reply: /cue|caption|filler|clean|tidi|done|\bum\b|\buh\b|remove|swept/i,
      gate: "work",
      anyTools: ["update_cue", "delete_cue", "merge_cue"],
      state: FILLER_STATE,
      simulate: () => makeTimelineSim(FILLER_STATE),
    },
    {
      // Plain questions answer from the snapshot; at most safe reads.
      name: "question-answers-in-chat",
      bucket: "chat",
      input: () => [userTurn("how long is my cut right now?")],
      reply: /12[.,]?5?/,
      budget: { totalMs: 6500 },
    },
    {
      // The "drag photos in, ask for a movie" flow: an explicit ask to put
      // attached media in the cut must reach add_clip for each photo. Styling
      // follow-ups a movie ask can reasonably trigger are stubbed too.
      name: "photos-request-places-clips",
      bucket: "multi-tool",
      input: () => [
        userTurn("stitch these two photos into a short movie", { attachRefs: PHOTO_REFS }),
      ],
      reply: /photo|movie|timeline|cut/i,
      requiredTools: ["add_clip"],
      stubs: {
        add_clip: { id: "c-new", kind: "image", index: 1, start: 12.5, len: 8 },
        set_transition: { ok: true },
        set_project_fade: { ok: true },
        add_title: { ok: true },
      },
    },
    {
      // Attached media with a question stays a chat deliverable: ideas in
      // text, the photos stay off the timeline (add_clip would be a violation).
      name: "photos-question-stays-in-chat",
      bucket: "chat",
      input: () => [
        userTurn("what could you make with these two photos?", { attachRefs: PHOTO_REFS }),
      ],
      // Any engaged ideas answer counts — the real assertion is that no
      // mutating tool ran on a question turn.
      reply: /photo|movie|montage|slideshow|cut|idea|story|transition|split|dog|pup|beach|park/i,
    },
    {
      // Destructive and organizing tools stay sheathed without an explicit
      // command: venting about clutter deletes and files nothing.
      name: "clutter-complaint-deletes-nothing",
      bucket: "chat",
      input: () => [userTurn("ugh, my project is getting cluttered with files")],
      reply: /media|asset|file|clean|organi|tidy|clutter|remove|delete/i,
    },
    {
      // Fast path: a plain text-only video ask is ONE generate_video call —
      // no scene pipeline, no image staging, no skill-doc detour first.
      name: "video-ask-single-generate",
      bucket: "single-tool",
      input: () => [userTurn("generate a video about dogs")],
      reply: /video|render|dog|minute/i,
      requiredTools: ["generate_video"],
      maxToolCalls: 2,
      budget: { totalMs: 14000 },
      stubs: {
        generate_video: {
          kind: "video",
          started: true,
          jobId: "job-dogs",
          addToTimeline: false,
          note:
            "Rendering — it previews in this chat when it lands, in a minute or two. It stays in the chat until the user places it.",
        },
      },
    },
    {
      // A size and a length in the ask ride the tool's own knobs: the call
      // carries resolution and duration_seconds.
      name: "video-ask-with-size-and-length",
      bucket: "single-tool",
      input: () => [userTurn("generate a 6 second 1080p video of a paper boat drifting across a puddle")],
      reply: /video|render|boat|minute/i,
      requiredTools: ["generate_video"],
      maxToolCalls: 2,
      simulate: () => (name, args) => {
        if (name !== "generate_video") return undefined;
        if (args.resolution !== "1080p")
          throw new Error(`generate_video resolution must be "1080p", got ${JSON.stringify(args.resolution)}`);
        if (args.duration_seconds !== 6)
          throw new Error(`generate_video duration_seconds must be 6, got ${JSON.stringify(args.duration_seconds)}`);
        return {
          kind: "video",
          started: true,
          jobId: "job-boat",
          addToTimeline: false,
          note:
            "Rendering — it previews in this chat when it lands, in a minute or two. It stays in the chat until the user places it.",
        };
      },
    },
    {
      // The screenshot regression: iterating on an existing clip ("make me a
      // better version / closer to the original / a different take") ADDS a
      // fresh generation and leaves the clip in place. Without an explicit
      // "delete / replace / remove this", deleting the user's existing work
      // to "make room" is wrong — the trap word "instead"/"version" is not a
      // delete instruction.
      name: "iterate-keeps-existing-clip",
      bucket: "single-tool",
      input: () => [
        userTurn("the beach clip feels off — make me a better version, more of a golden-hour sunset"),
      ],
      reply: /version|render|sunset|golden|minute|new|preview|kept|left|place/i,
      requiredTools: ["generate_video"],
      simulate: () => (name) => {
        if (name === "delete_item")
          throw new Error("delete_item — iterating is not a delete/replace; the existing clip must stay");
        if (name === "delete_asset")
          throw new Error("delete_asset — iterating must not remove the existing clip's media");
        // A reversible grade toward the asked-for look may ride along.
        if (name === "set_color_grade") return { ok: true };
        return undefined;
      },
      stubs: {
        generate_video: {
          kind: "video",
          started: true,
          jobId: "job-sunset",
          addToTimeline: false,
          note:
            "Rendering a new take — it previews in this chat when it lands, in a minute or two. Your current clip stays put.",
        },
      },
    },
    {
      // The screenshot regression: after a turn that imported a reference and
      // styled the cut, "mute all clips" mutes and stops. A replayed
      // conversation carries no tool traffic, so without the <tools_ran>
      // ledger the model reads its own last reply as an unfinished plan and
      // runs the whole thing again — re-importing, re-watching, re-styling —
      // then narrates that as the answer. The snapshot names every clip and
      // its muted flag, so the mute needs no reads either.
      name: "mute-all-does-not-redo-prior-turn",
      bucket: "single-tool",
      input: () => [
        plainUserTurn(
          "use the illustration style at https://x.com/example/status/1 and blend the three city clips together"
        ),
        assistantToolTurn(
          "Imported the reference illustration and blended Seoul, San Francisco, and Toronto with 1-second crosszooms.",
          ["import_url", "watch_video", "watch_video", "watch_video", "set_transition", "set_transition"]
        ),
        userTurn("mute all clips", { state: STYLED_STATE }),
      ],
      reply: /mut/i,
      // Per-clip mutes or the track header's speaker toggle both land it.
      anyTools: ["set_clip_muted", "set_track_muted"],
      maxToolCalls: 3,
      state: STYLED_STATE,
      simulate: () => (name) => {
        if (name === "import_url" || name === "watch_video" || name === "set_transition")
          throw new Error(`${name} — the previous turn already ran it; "mute all clips" only mutes`);
        return undefined;
      },
      stubs: { set_clip_muted: { muted: true }, set_track_muted: { muted: true } },
    },
    {
      // The tweet-import flow: after import_url landed a photo in an earlier
      // turn, "the exact same thing but…" must anchor generate_image on that
      // asset via reference_asset_ids — the compose pass and image model see
      // the real photo only through the reference, so a text-only render of
      // the model's guess loses the source image entirely.
      name: "imported-photo-edit-references-photo",
      bucket: "single-tool",
      input: () => [
        plainUserTurn("https://x.com/oggii_0/status/2079613105571828043"),
        assistantTurn(
          `Imported the photo from that post — it's on a card in this chat. The post says: "${TWEET_ASSET.name}".`
        ),
        userTurn("generate the exact same thing but put her in a santa hat", {
          state: TWEET_STATE,
        }),
      ],
      reply: /santa|hat|image|render|preview/i,
      requiredTools: ["generate_image"],
      state: TWEET_STATE,
      simulate: () => (name, args) => {
        if (name === "generate_image") {
          const refs = Array.isArray(args.reference_asset_ids)
            ? args.reference_asset_ids.map(String)
            : [];
          if (!refs.includes(TWEET_ASSET.id))
            throw new Error(
              `generate_image must reference ${TWEET_ASSET.id}, got ${JSON.stringify(args.reference_asset_ids)}`
            );
          return {
            assetId: "a-gen1",
            kind: "image",
            note: "Rendered — the image previews on a card in this chat.",
          };
        }
        if (name === "watch_video")
          return { note: "Eval: the photo shows a young woman smiling outdoors in falling snow." };
        if (name === "generate_video" || name === "generate_scene")
          throw new Error(`${name} called — an edited copy of a photo is a generate_image ask`);
        return undefined;
      },
    },
    {
      // Fast path: audio generation goes straight to voiceover_generate
      // (list_voices is a fine extra hop, more than that is a detour).
      name: "audio-ask-single-generate",
      bucket: "single-tool",
      input: () => [userTurn("generate a voiceover that says welcome to the dog show")],
      reply: /voice|audio|narrat|welcome/i,
      requiredTools: ["voiceover_generate"],
      maxToolCalls: 3,
      stubs: {
        voiceover_generate: {
          assetId: "a-tts2",
          name: "AI voice — welcome to the dog show",
          start: 0,
          duration: 2.3,
          voice: "aoede",
        },
      },
    },
    {
      // Background music goes straight to generate_music (voiceover_generate
      // is speech; generate_scene is a whole narrated production). "Add … to
      // this video" asks for placement, so the call carries add_to_timeline
      // and the soundtrack gets the bed in the same tool call.
      name: "music-ask-single-generate",
      bucket: "single-tool",
      input: () => [userTurn("add some chill background music to this video")],
      reply: /music|track|bed|chill|background/i,
      requiredTools: ["generate_music"],
      maxToolCalls: 3,
      simulate: () => (name, args) => {
        if (name !== "generate_music") return undefined;
        if (args.add_to_timeline !== true && typeof args.start !== "number")
          throw new Error(
            "generate_music without placement — the user asked for music in the video, pass add_to_timeline"
          );
        return {
          assetId: "a-music1",
          name: "chill background music",
          duration: 30,
          addedToTimeline: true,
          start: 0,
          volume: 0.35,
        };
      },
    },
    {
      // Fast path: a direct edit is one trim_clip on the clip in the snapshot.
      name: "trim-ask-single-tool",
      bucket: "single-tool",
      input: () => [userTurn("trim the first clip down to 5 seconds")],
      reply: /trim|5|second/i,
      requiredTools: ["trim_clip"],
      maxToolCalls: 2,
      stubs: { trim_clip: { in: 0, out: 5, len: 5 } },
      budget: { totalMs: 10000 },
    },
    {
      // Effects: a styled transition ask is one set_transition on the LEADING
      // clip with the catalog style id (a skill read on the way is fine).
      name: "transition-ask-styled",
      bucket: "single-tool",
      input: () => [
        userTurn("add a push down transition between the two clips", { state: TWO_CLIP_STATE }),
      ],
      reply: /push|transition/i,
      requiredTools: ["set_transition"],
      maxToolCalls: 3,
      state: TWO_CLIP_STATE,
      simulate: () => (name, args) => {
        if (name !== "set_transition") return undefined;
        if (args.clipId !== "c1")
          throw new Error(`set_transition on ${args.clipId} — the transition belongs to the leading clip c1`);
        if (args.style !== "pushdown")
          throw new Error(`style ${args.style} — expected pushdown`);
        return { id: "c1", transition: Number(args.seconds) || 0.5, style: "pushdown" };
      },
    },
    {
      // Directional comprehension: slide names are the motion direction, so
      // "slide in from the left" moves rightward — slideright on c2's "in".
      name: "slide-in-direction-correct",
      bucket: "single-tool",
      input: () => [
        userTurn("make the second clip slide in from the left", { state: TWO_CLIP_STATE }),
      ],
      reply: /slide/i,
      requiredTools: ["set_animation"],
      maxToolCalls: 3,
      state: TWO_CLIP_STATE,
      simulate: () => (name, args) => {
        if (name !== "set_animation") return undefined;
        if (args.clipId !== "c2" || args.which !== "in")
          throw new Error(`set_animation ${args.clipId}/${args.which} — expected c2 "in"`);
        if (args.style !== "slideright")
          throw new Error(`style ${args.style} — "from the left" moves rightward (slideright)`);
        return { id: "c2", which: "in", style: "slideright", seconds: Number(args.seconds) || 0.5 };
      },
    },
    {
      // Looks and treatments are timeline effects: a VHS ask on a clip is one
      // add_effect with the catalog's vhs id spanning that clip's window. A
      // hand-rolled set_color_grade approximation stays a violation.
      name: "look-ask-single-tool",
      bucket: "single-tool",
      input: () => [
        userTurn("give the second clip a retro VHS look", { state: TWO_CLIP_STATE }),
      ],
      reply: /vhs|retro|look/i,
      requiredTools: ["add_effect"],
      maxToolCalls: 3,
      state: TWO_CLIP_STATE,
      simulate: () => (name, args) => {
        if (name !== "add_effect") return undefined;
        if (args.effect !== "vhs") throw new Error(`effect ${args.effect} — expected vhs`);
        const start = Number(args.start ?? 0);
        const end = Number(args.end ?? start + 3);
        if (start > 6.5 || end < 11.5)
          throw new Error(`effect spans ${start}..${end} — the second clip runs 6..12.5`);
        return { id: "fx1", effect: "vhs", start, end, amount: Number(args.amount) || 0.5 };
      },
    },
    {
      // "Sound like a phone" on one clip has two shipped treatments and either
      // is the ask done in one call: the telephone effect element spanning
      // that clip, or the clip's own Sound quality "Phone / Lo-Fi" preset.
      // The per-clip level knobs (volume, fades, duck) miss it.
      name: "audio-effect-single-tool",
      bucket: "single-tool",
      input: () => [
        userTurn("make the second clip sound like it's coming through a phone", {
          state: TWO_CLIP_STATE,
        }),
      ],
      reply: /phone|telephone|effect|lo-fi/i,
      anyTools: ["add_effect", "set_clip_sound"],
      maxToolCalls: 3,
      state: TWO_CLIP_STATE,
      simulate: () => (name, args) => {
        if (name === "set_clip_sound") {
          if (args.clipId !== "c2") throw new Error(`set_clip_sound on ${args.clipId} — the second clip is c2`);
          if (!/phone/i.test(String(args.preset ?? "")))
            throw new Error(`set_clip_sound preset ${JSON.stringify(args.preset)} — expected the Phone / Lo-Fi preset`);
          return { id: "c2", preset: "phone" };
        }
        if (name !== "add_effect") return undefined;
        if (args.effect !== "telephone") throw new Error(`effect ${args.effect} — expected telephone`);
        const start = Number(args.start ?? 0);
        const end = Number(args.end ?? start + 3);
        if (start > 6.5 || end < 11.5)
          throw new Error(`effect spans ${start}..${end} — the second clip runs 6..12.5`);
        return { id: "fx1", effect: "telephone", start, end, amount: Number(args.amount) || 0.5 };
      },
    },
    {
      // "Only the audio" at a cut is a transition style, not an effect and not
      // per-clip fades: audiocross leaves the picture a hard cut and dissolves
      // the sound across it.
      name: "sound-dissolve-single-tool",
      bucket: "single-tool",
      input: () => [
        userTurn("keep the cut between the two clips but cross dissolve just the audio", {
          state: TWO_CLIP_STATE,
        }),
      ],
      reply: /audio|sound|dissolve/i,
      requiredTools: ["set_transition"],
      maxToolCalls: 3,
      state: TWO_CLIP_STATE,
      simulate: () => (name, args) => {
        if (name !== "set_transition") return undefined;
        if (args.style !== "audiocross")
          throw new Error(`style ${args.style} — expected audiocross`);
        const seconds = Number(args.seconds ?? 0);
        if (!(seconds > 0)) throw new Error(`seconds ${seconds} — a dissolve needs a window`);
        return { clipId: String(args.clipId), seconds, style: "audiocross" };
      },
    },
    {
      // Last pick wins per edge: swapping a crossfading joint for an entrance
      // animation is a set_animation — the override clears the transition
      // itself (an explicit set_transition 0 first is fine, not required).
      // "Pop" exists only as an animation, so the routing is unambiguous
      // (a wipe ask could legitimately become a wipe *transition* instead).
      name: "animation-overrides-transition",
      bucket: "single-tool",
      input: () => [
        userTurn("get rid of the crossfade — make the second clip pop in instead", {
          state: CROSSFADED_STATE,
        }),
      ],
      reply: /pop/i,
      requiredTools: ["set_animation"],
      maxToolCalls: 4,
      state: CROSSFADED_STATE,
      simulate: () => (name, args) => {
        if (name === "set_transition") return { id: "c1", transition: 0, style: "crossfade" };
        if (name !== "set_animation") return undefined;
        if (args.clipId !== "c2" || args.which !== "in")
          throw new Error(`set_animation ${args.clipId}/${args.which} — expected c2 "in"`);
        if (args.style !== "pop") throw new Error(`style ${args.style} — expected pop`);
        return { id: "c2", which: "in", style: "pop", seconds: 0.5 };
      },
    },
    {
      // Driving the editor on the user's behalf: with a transcript in the
      // snapshot, "cut the filler words" must land real timeline cuts (split
      // then delete, or a trim) — talking about them or only rewriting the
      // captions fails. Post-cut cleanup rides along: refine_speech_cuts on
      // the recut edges, soundtrack re-alignment, and a caption refresh over
      // the tightened cut.
      name: "filler-words-cut-with-editor",
      bucket: "multi-tool",
      input: () => [userTurn("cut the filler words out of my video", { state: FILLER_STATE })],
      reply: /filler|um|uh|cut|remove|trim/i,
      anyTools: ["split_at", "delete_item", "trim_clip"],
      state: FILLER_STATE,
      simulate: () => makeTimelineSim(FILLER_STATE),
      stubs: {
        subtitles_generate: {
          status: "done",
          track: 0,
          locale: "en-US",
          count: 3,
          cues: [
            { id: "ncue1", start: 0, end: 2.1, text: "So today we're at the beach with the dogs" },
            { id: "ncue2", start: 2.1, end: 4.9, text: "they absolutely love the water" },
            { id: "ncue3", start: 4.9, end: 7.5, text: "so let's watch them play" },
          ],
          note: "Re-transcribed the tightened cut.",
        },
        subtitles_remove_track: { removed: 0 },
      },
    },
    {
      // Control: a real edit request must still act with tools — guards
      // against over-suppressing tool use.
      name: "edit-request-still-uses-tools",
      bucket: "single-tool",
      input: () => [userTurn("add captions to my video")],
      reply: /caption|subtitle/i,
      requiredTools: ["subtitles_generate"],
      stubs: {
        subtitles_generate: {
          status: "done",
          track: 0,
          locale: "en-US",
          cues: 12,
          note: "Transcribed the cut onto subtitle track 0.",
        },
      },
    },
    {
      // A cartoon ask over project audio is one generate_scene plan: the
      // audio rides as the spine, the plan waits for the user's go-ahead,
      // and a 9:16 project takes 9:16 shots.
      name: "cartoon-from-audio-plans-scene",
      bucket: "single-tool",
      input: () => [
        userTurn("turn my narration audio into a smooth 2D cartoon", { state: AUDIO_STATE }),
      ],
      reply: /shot|plan|confirm|approv|cartoon|scene/i,
      requiredTools: ["generate_scene"],
      state: AUDIO_STATE,
      simulate: makeSceneSim((args) => {
        if (String(args.from_audio_asset_id ?? "") !== NARRATION_ASSET.id)
          throw new Error(
            `generate_scene must animate ${NARRATION_ASSET.id}, got ${JSON.stringify(args.from_audio_asset_id)}`
          );
        if (args.aspect !== undefined && args.aspect !== "9:16")
          throw new Error(
            `generate_scene aspect must match the 9:16 project, got ${JSON.stringify(args.aspect)}`
          );
      }),
    },
    {
      // Foreign source audio: the speech language rides audio_language so the
      // on-device recognizer matches, and the audio still spines the cut.
      name: "cartoon-korean-audio-passes-language",
      bucket: "single-tool",
      input: () => [
        userTurn("my narration audio is in Korean — turn it into a smooth 2D cartoon", {
          state: AUDIO_STATE,
        }),
      ],
      reply: /shot|plan|confirm|approv|cartoon|scene|korean/i,
      requiredTools: ["generate_scene"],
      state: AUDIO_STATE,
      simulate: makeSceneSim((args) => {
        if (String(args.from_audio_asset_id ?? "") !== NARRATION_ASSET.id)
          throw new Error("generate_scene must animate the narration audio");
        if (!/^ko(-|$)/i.test(String(args.audio_language ?? "")))
          throw new Error(
            `audio_language must name Korean, got ${JSON.stringify(args.audio_language)}`
          );
      }),
    },
    {
      // A style image attached to the ask anchors the scene's look: its asset
      // id must ride reference_asset_ids into the plan.
      name: "cartoon-style-reference-anchors-look",
      bucket: "single-tool",
      input: () => [
        userTurn("make a cartoon episode from my narration audio in the style of this picture", {
          state: AUDIO_STATE,
          attachRefs: [PHOTO_REFS[0]],
        }),
      ],
      reply: /shot|plan|confirm|approv|cartoon|scene|style/i,
      requiredTools: ["generate_scene"],
      state: AUDIO_STATE,
      simulate: makeSceneSim((args) => {
        const refs = Array.isArray(args.reference_asset_ids)
          ? args.reference_asset_ids.map(String)
          : [];
        if (!refs.includes(PHOTO_ASSETS[0].id))
          throw new Error(
            `reference_asset_ids must carry ${PHOTO_ASSETS[0].id}, got ${JSON.stringify(args.reference_asset_ids)}`
          );
      }),
    },
    {
      // A "how would you" cartoon question is a chat deliverable: approach in
      // words, the scene pipeline untouched (generate_scene would violate).
      name: "cartoon-question-stays-in-chat",
      bucket: "chat",
      input: () => [
        userTurn("how would you turn my narration audio into a 2D cartoon?", {
          state: AUDIO_STATE,
        }),
      ],
      reply: /cartoon|scene|shot|animate|style|narration/i,
      state: AUDIO_STATE,
    },
    {
      // Timeline mentions: "@c1 and @c2 are too similar" must map through the
      // clip attachments to videoTrack's sceneShot numbers and revise those
      // exact shots on the revision ladder — regenerate_shot per shot with the
      // complaint riding as the note, or one recut_scene over the 1..2 span.
      // Waiting on the new takes with wait_for_renders is part of finishing
      // the ask. A fresh generate_video/generate_scene orphans the shots.
      name: "clip-mentions-redo-their-shots",
      bucket: "multi-tool",
      input: () => [
        userTurn(
          "clip 1 and clip 2 are too similar and they don't match the audio. fix them",
          { attachRefs: CLIP_REFS, state: SCENE_DONE_STATE }
        ),
      ],
      reply: /shot|redo|regenerat|recut|replan/i,
      anyTools: ["regenerate_shot", "recut_scene"],
      state: SCENE_DONE_STATE,
      simulate: () => {
        const redone = new Set<number>();
        return (name, args) => {
          if (name === "regenerate_shot") {
            const n = Number(args.n);
            if (n !== 1 && n !== 2) throw new Error(`regenerate_shot ${n} — the mentions were shots 1 and 2`);
            if (!String(args.note ?? "").trim()) throw new Error("regenerate_shot without the user's note");
            redone.add(n);
            return { ok: true, message: `Redoing shot ${n}…` };
          }
          if (name === "recut_scene") {
            if (Number(args.from_shot) !== 1 || Number(args.to_shot) !== 2)
              throw new Error(
                `recut_scene ${args.from_shot}..${args.to_shot} — the mentions were shots 1 and 2`
              );
            if (!String(args.instruction ?? "").trim())
              throw new Error("recut_scene without the user's ask as its instruction");
            return { ok: true, replanning: [1, 2], note: "Replanning shots 1-2 over the same audio; new takes are rendering." };
          }
          if (name === "wait_for_renders")
            return { renders: [{ status: "landed", note: "eval: revised takes swapped into their shots" }] };
          if (name === "generate_video" || name === "generate_scene" || name === "restyle_scene")
            throw new Error(`${name} called — a clip complaint revises its shots in place`);
          return undefined;
        };
      },
    },
    {
      // The QA-loop regression from the field: a retime parks a transition
      // bar; the mutation result and the turn ledger both report it, and the
      // turn owns the debris — reattached or removed — before replying.
      name: "parked-debris-cleanup-after-retime",
      bucket: "multi-tool",
      input: () => [userTurn("speed up the san francisco clip 2x", { state: PARKED_STATE })],
      reply: /speed|2x|faster/i,
      requiredTools: ["set_speed"],
      anyTools: ["remove_transition", "set_transition"],
      state: PARKED_STATE,
      simulate: () => (name, args) => {
        if (name === "set_speed") {
          return {
            id: args.clipId ?? "c2",
            speed: 2,
            parkedTransitions: [{ id: "tr-2", start: 6.4, seconds: 1, style: "crosszoom" }],
            parkedTransitionsNote:
              "This edit left 1 transition bar lining up with nothing — reattach it with set_transition or clear it with remove_transition.",
          };
        }
        if (name === "remove_transition") return { removed: args.transitionId };
        if (name === "set_transition")
          return { id: args.clipId, transitionId: "tr-2", transition: args.seconds, style: "crosszoom" };
        return undefined;
      },
    },
    {
      // A described ramp is a curve, laid in one call: the shape the user
      // asked for lands as nodes over the clip's footage.
      name: "speed-ramp-from-description",
      bucket: "single-tool",
      input: () => [
        userTurn("ease the san francisco clip into slow motion at the end", { state: PARKED_STATE }),
      ],
      reply: /slow|ramp|curve|ease/i,
      requiredTools: ["set_speed_curve"],
      state: PARKED_STATE,
      simulate: () => (name, args) => {
        if (name === "set_speed_curve") {
          return {
            id: args.clipId ?? "c2",
            nodes: [
              { at: 0, speed: 1 },
              { at: 6, speed: 0.4 },
            ],
            speed: 0.7,
            len: 8.6,
          };
        }
        return undefined;
      },
    },
    {
      // Scope: "the grey ones" are the parked bars alone. The attached pair
      // keeps playing; clearing one of them is the over-rotation regression.
      name: "remove-grey-ones-scope",
      bucket: "multi-tool",
      input: () => [userTurn("remove the grey transitions on the timeline", { state: PARKED_STATE })],
      reply: /remov|clear/i,
      requiredTools: ["remove_transition"],
      state: PARKED_STATE,
      simulate: () => {
        const wrong: string[] = [];
        const sim = (name: string, args: Record<string, unknown>) => {
          if (name === "remove_transition") {
            const id = String(args.transitionId ?? "");
            if (id === "tr-1" || id === "tr-2") wrong.push(id);
            return { removed: id };
          }
          return undefined;
        };
        sim.verify = () =>
          wrong.length > 0 ? [`removed attached transitions: ${wrong.join(", ")}`] : [];
        return sim;
      },
    },
    {
      // A failed call produced nothing; the reply owns the failure in plain
      // words. Claiming the crossfade landed is the grounding regression.
      name: "errored-call-not-claimed-done",
      bucket: "single-tool",
      input: () => [userTurn("add a small crossfade on the last clip", { state: TWO_CLIP_STATE })],
      reply: /last clip|nothing after|no clip after|can('|no)t|couldn't|didn('|o)t/i,
      requiredTools: ["set_transition"],
      state: TWO_CLIP_STATE,
      stubs: {
        set_transition: {
          __error: "That is its track's last clip — nothing after it to transition into.",
        },
      },
    },
    {
      // Auto-continue: with a one-round budget the loop extends itself and the
      // job still lands — the user never types "keep going".
      name: "auto-continue-no-handoff",
      bucket: "multi-tool",
      input: () => [
        plainUserTurn("could you clean up my captions? lots of filler words"),
        assistantTurn("I can tidy the five cues on track 0, dropping the ums and uhs — say the word."),
        userTurn("yes do it", { state: FILLER_STATE }),
      ],
      reply: /cue|caption|filler|clean|tidi|done|\bum\b|\buh\b|remove|swept/i,
      anyTools: ["update_cue", "delete_cue", "merge_cue"],
      state: FILLER_STATE,
      simulate: () => makeTimelineSim(FILLER_STATE),
      limits: { roundBudget: 1, maxExtensions: 3 },
      extensions: { min: 1 },
    },
    {
      // Over-suppression guard: a genuinely ambiguous ask still gets the
      // clarifying question.
      name: "question-when-ambiguous",
      bucket: "chat",
      input: () => [userTurn("make that clip a bit shorter", { state: STYLED_STATE })],
      reply: /which|clarify|\?/i,
      state: STYLED_STATE,
      expectsQuestion: true,
      maxToolCalls: 2,
    },
    {
      // The ledger's non-transition debris class: a title stranded past the
      // video's end surfaces in the reply (or gets fixed), even though the ask
      // was about something else.
      name: "orphaned-overlay-debris",
      bucket: "multi-tool",
      input: () => [userTurn("trim the beach clip to end at 10 seconds", { state: STRANDED_TITLE_STATE })],
      reply: /title|overlay|past the end|THE END|stranded/i,
      requiredTools: ["trim_clip"],
      // The stranded title is the user's own work — asking before moving or
      // deleting it is the correct close.
      expectsQuestion: true,
      state: STRANDED_TITLE_STATE,
      debris: ['overlay ov-7 ("THE END") starts at 14s, past the video\'s end at 12.5s'],
      simulate: () => (name, args) => {
        if (name === "trim_clip") return { id: args.clipId ?? "c1", in: 0, out: 10 };
        if (name === "update_overlay" || name === "delete_item")
          return { ok: true, id: args.id ?? "ov-7" };
        return undefined;
      },
    },
    {
      // A thread from before the pi loop replays its tool history as prose;
      // nothing tag-shaped may leak into the fresh reply.
      name: "legacy-thread-no-leak",
      bucket: "chat",
      input: () => [
        plainUserTurn("add nice transitions between my clips"),
        assistantToolTurn("Added a crosszoom between each pair of city clips.", [
          "set_transition",
          "set_transition",
        ]),
        userTurn("what transition style did you use?", { state: STYLED_STATE }),
      ],
      reply: /crosszoom|cross.?zoom/i,
      state: STYLED_STATE,
      maxToolCalls: 2,
    },
    {
      // Grading: a mood ask lands as one set_color_preset with a pick from
      // the matching catalog category — a hand-rolled slider stack fails.
      name: "cinematic-ask-picks-preset",
      bucket: "single-tool",
      input: () => [userTurn("give my video a cinematic color grade")],
      reply: /cinematic|grade|preset|teal|look/i,
      requiredTools: ["set_color_preset"],
      maxToolCalls: 4,
      simulate: () => (name, args) => {
        if (name !== "set_color_preset") return undefined;
        const pick = String(args.preset);
        const ids = gradePresetsInCategory("cinematic").map((p) => p.id);
        if (!ids.includes(pick))
          throw new Error(`preset ${pick} — expected a cinematic pick (${ids.join(", ")})`);
        return { id: args.clipId ?? "c1", preset: pick, amount: Number(args.amount ?? 1) };
      },
    },
    {
      // Semantic grading: "warmer" is temperature above zero and "crush the
      // blacks" pushes shadows down (or deepens the low end of the master
      // curve) — the interceptor fails any move in the wrong direction.
      name: "warmer-crushed-blacks-in-range",
      bucket: "single-tool",
      input: () => [userTurn("make the beach clip warmer and crush the blacks a little")],
      reply: /warm|black|shadow|grade/i,
      requiredTools: ["set_color_grade"],
      maxToolCalls: 5,
      simulate: () => (name, args) => {
        if (name === "set_color_grade") {
          if (typeof args.temperature === "number" && args.temperature <= 0)
            throw new Error(`temperature ${args.temperature} — warmer means above 0`);
          if (typeof args.shadows === "number" && args.shadows >= 0)
            throw new Error(`shadows ${args.shadows} — crushing blacks means below 0`);
          return { id: args.clipId ?? "c1", grade: { temperature: args.temperature ?? 0, shadows: args.shadows ?? 0 } };
        }
        if (name === "set_color_curves") {
          if (typeof args.fade === "number" && args.fade > 0)
            throw new Error(`fade ${args.fade} — fade lifts the blacks, the ask crushes them`);
          const master = Array.isArray(args.master) ? (args.master as number[][]) : [];
          for (const [x, y] of master)
            if (x <= 80 && y > x)
              throw new Error(`master point [${x}, ${y}] lifts the low end — crushing pulls it down`);
          return { id: args.clipId ?? "c1", curves: { master } };
        }
        return undefined;
      },
    },
    {
      // Per-hue isolation: "just the sky" is one hue band, so the move is
      // set_color_hsl on aqua or blue — a whole-frame saturation push leaks
      // onto everything else and fails.
      name: "sky-bluer-single-band",
      bucket: "single-tool",
      input: () => [userTurn("make the sky bluer without changing anything else")],
      reply: /sky|blue/i,
      requiredTools: ["set_color_hsl"],
      maxToolCalls: 4,
      simulate: () => (name, args) => {
        if (name === "set_color_grade" && (typeof args.saturation === "number" || typeof args.hue === "number"))
          throw new Error("whole-frame color move — the ask isolates one hue, use set_color_hsl");
        if (name !== "set_color_hsl") return undefined;
        const band = String(args.band);
        if (band !== "aqua" && band !== "blue")
          throw new Error(`band ${band} — the sky lives in aqua/blue`);
        const sat = Number(args.sat ?? 0);
        const hue = Number(args.hue ?? 0);
        if (sat === 0 && hue === 0)
          throw new Error("all-zero band clears it — bluer needs a sat or hue move");
        if (sat < 0) throw new Error(`sat ${sat} — bluer means saturation up`);
        return { id: args.clipId ?? "c1", band, hue, sat, luma: Number(args.luma ?? 0) };
      },
    },
    {
      // Reference matching: a shared look-to-copy routes to the computed
      // match on the attached photo — an eyeballed slider stack fails. The
      // stats stub keeps a read-before/verify-after pass cheap and grounded.
      name: "reference-photo-matches-grade",
      bucket: "single-tool",
      input: () => [
        userTurn("match my video's colors to this photo", { attachRefs: [PHOTO_REFS[0]] }),
      ],
      reply: /match|color|grade|photo/i,
      requiredTools: ["match_color_grade"],
      maxToolCalls: 6,
      simulate: () => (name, args) => {
        if (name !== "match_color_grade") return undefined;
        if (args.ref_asset_id !== PHOTO_REFS[0].id)
          throw new Error(`ref ${args.ref_asset_id ?? args.ref_clip_id} — the attached photo is asset ${PHOTO_REFS[0].id}`);
        if (args.clipId !== "c1")
          throw new Error(`clip ${args.clipId} — the video on the timeline is c1`);
        return {
          id: "c1",
          grade: { curves: { r: [[0, 0], [128, 138], [255, 255]], b: [[0, 0], [128, 120], [255, 255]] }, saturation: 6 },
          note: "Verify with read_color_stats on the clip and refine with the grading tools.",
        };
      },
      stubs: {
        read_color_stats: {
          quantiles: "values 0..255 at p2, p10, p25, p50, p75, p90, p98",
          r: [8, 24, 62, 118, 172, 214, 244],
          g: [7, 22, 58, 112, 166, 208, 240],
          b: [10, 28, 70, 130, 182, 220, 248],
          luma: [8, 23, 61, 116, 170, 211, 242],
          meanR: 121,
          meanG: 114,
          meanB: 133,
          meanSat: 0.24,
          warmth: 0.91,
        },
      },
    },
  ];
}
