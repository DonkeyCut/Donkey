// The instant path's labelled turns: the ask, and the tool call the
// judgment has to settle it to. `tool: null` means the turn must NOT go
// instant — the ask needs several steps, an exact figure, more than one
// item, or something the registry does not cover, and the chat loop takes
// it. `args` is checked as a subset, so a case pins only the arguments it
// cares about; a number is allowed a tolerance because a Score gives a
// position on a described scale, not a figure.

export interface InstantCase {
  request: string;
  recent?: { role: "user" | "assistant"; text: string }[];
  tool: string | null;
  args?: Record<string, unknown>;
  /** How far a numeric argument may sit from the labelled value. */
  tol?: number;
}

/** A project with something of every kind on it, so every tier of the
 * registry is offered and the targets have to be told apart. */
export const INSTANT_STATE = {
  project: { id: "p-instant", name: "Trip", duration: 22, aspect: "9:16", frame: "1080x1920" },
  playhead: 6.5,
  skimmer: null,
  playing: false,
  selection: { kind: "clip", id: "c2", asset: "market.mp4", start: 8, len: 6 },
  media: [
    { id: "a-v1", name: "airport.mp4", type: "video", duration: 30 },
    { id: "a-v2", name: "market.mp4", type: "video", duration: 24 },
    { id: "a-v3", name: "sunset.mp4", type: "video", duration: 18 },
    { id: "a-m1", name: "lofi-bed.mp3", type: "audio", duration: 90, origin: "stock" },
    { id: "a-p1", name: "passport.jpg", type: "image", duration: 0 },
  ],
  mediaTruncated: false,
  videoTrack: [
    { index: 0, id: "c1", asset: "airport.mp4", start: 0, len: 8, in: 0, out: 8, muted: false, framing: "fit", speed: 1 },
    { index: 1, id: "c2", asset: "market.mp4", start: 8, len: 6, in: 2, out: 8, muted: false, framing: "fit", speed: 1 },
    { index: 2, id: "c3", asset: "sunset.mp4", start: 14, len: 8, in: 0, out: 8, muted: true, framing: "fill", speed: 1 },
  ],
  overlayVideo: [],
  transitions: [{ id: "tr1", start: 8, seconds: 0.4, style: "crossfade", plays: [{ at: "out", clipId: "c1" }] }],
  soundtrack: [
    { id: "au1", asset: "lofi-bed.mp3", start: 0, len: 22, in: 0, out: 22, volume: 1, fadeIn: 0, fadeOut: 0 },
  ],
  overlays: [
    { id: "ov1", kind: "text", text: "Day one", start: 0.5, end: 3.5 },
    { id: "ov2", kind: "text", text: "The market", start: 8.5, end: 11 },
    { id: "ov3", kind: "shape", name: "Divider", start: 14, end: 16 },
  ],
  subtitles: {
    count: 3,
    showOnVideo: true,
    showOnTimeline: true,
    activeTrack: 0,
    tracks: [{ track: 0, locale: "en-US", cues: 3 }],
    wordsPerCue: 5,
    status: "ready",
    cues: [
      { id: "q1", start: 1, end: 2.4, text: "we landed at six in the morning" },
      { id: "q2", start: 2.4, end: 4.1, text: "and went straight to the market" },
      { id: "q3", start: 9, end: 11, text: "everything here is unbelievably cheap" },
    ],
    cuesTruncated: false,
  },
  publish: { caption: "", tags: "", soundTitle: "", handle: "" },
  view: { pxPerSec: 60, timelineH: 260, exportDialogOpen: false },
};

export const instantCases: InstantCase[] = [
  // ── no target: the editor's own verbs ────────────────────────────────
  { request: "undo that", tool: "undo" },
  {
    request: "actually put that back",
    recent: [
      { role: "user", text: "undo that" },
      { role: "assistant", text: "Undone." },
    ],
    tool: "redo",
  },
  { request: "split it here", tool: "split_at" },
  { request: "pause", tool: "set_playing", args: { playing: false } },
  { request: "play it", tool: "set_playing", args: { playing: true } },
  { request: "open the export dialog", tool: "open_export" },
  { request: "show me the effects panel", tool: "set_side_panel", args: { panel: "effects" } },
  { request: "make it 16:9", tool: "set_aspect", args: { aspect: "16:9" } },
  { request: "make this vertical for tiktok", tool: "set_aspect", args: { aspect: "9:16" } },
  { request: "take the captions off the video", tool: "subtitles_set_view", args: { showOnVideo: false } },
  { request: "lift the audio off this clip", tool: "detach_audio" },

  // ── one named target ─────────────────────────────────────────────────
  { request: "mute the airport clip", tool: "set_clip_muted", args: { clipId: "c1", muted: true } },
  { request: "unmute the sunset one", tool: "set_clip_muted", args: { clipId: "c3", muted: false } },
  { request: "hide the market clip", tool: "set_clip_hidden", args: { clipId: "c2", hidden: true } },
  { request: "delete the airport clip", tool: "delete_item", args: { kind: "clip", id: "c1" } },
  { request: 'get rid of the "Day one" title', tool: "delete_item", args: { kind: "overlay", id: "ov1" } },
  { request: "delete the divider shape", tool: "delete_item", args: { kind: "overlay", id: "ov3" } },
  { request: "select the sunset clip", tool: "select", args: { kind: "clip", id: "c3" } },
  { request: "drop the caption about the market", tool: "delete_cue", args: { id: "q2" } },
  { request: 'join the "and went straight to the market" caption into the line before it', tool: "merge_cue", args: { id: "q2" } },
  { request: "take the crossfade off", tool: "remove_transition", args: { transitionId: "tr1" } },
  { request: "mute the whole soundtrack", tool: "set_track_hidden" },
  { request: "put the passport photo on the timeline", tool: "add_clip", args: { asset_id: "a-p1" } },
  { request: "move the sunset video onto the library shelf", tool: "file_asset", args: { asset_id: "a-v3", to: "library" } },

  // ── a closed enum ────────────────────────────────────────────────────
  { request: "put a crossfade after the airport clip", tool: "set_transition", args: { clipId: "c1", style: "crossfade" } },
  { request: "dip to black between the first two clips", tool: "set_transition", args: { clipId: "c1", style: "dipblack" } },
  { request: "fade the market clip in", tool: "set_animation", args: { clipId: "c2", which: "in" } },
  {
    request: "make the sunset clip slide in from the left",
    tool: "set_animation",
    args: { clipId: "c3", which: "in", style: "slideright" },
  },
  { request: "give the sunset clip a cinematic look", tool: "set_color_preset", args: { clipId: "c3" } },
  { request: "make the sunset clip black and white", tool: "set_color_preset", args: { clipId: "c3" } },
  { request: "fill the frame with the airport footage", tool: "set_framing", args: { clipId: "c1", mode: "fill" } },
  { request: "mirror the market clip", tool: "set_framing", args: { clipId: "c2", flipH: true } },
  { request: "cut the background out of the market clip", tool: "set_removal", args: { clipId: "c2", mode: "auto", remove: "background" } },
  { request: 'have "The market" slide in', tool: "set_overlay_animation", args: { id: "ov2" } },
  { request: 'make "Day one" pulse while it holds', tool: "set_overlay_animation", args: { id: "ov1" } },
  { request: "add film grain over the whole thing", tool: "add_effect", args: { effect: "grain" } },
  { request: "give the market clip a retro VHS look", tool: "add_effect", args: { effect: "vhs", start: 8, end: 14 } },

  // ── a numeric band, described rather than named ──────────────────────
  { request: "slow the sunset clip way down", tool: "set_speed", args: { clipId: "c3", speed: 0.3 }, tol: 0.35 },
  { request: "speed the airport clip up a lot", tool: "set_speed", args: { clipId: "c1", speed: 3 }, tol: 1.5 },
  { request: "play the market clip backwards", tool: "set_speed", args: { clipId: "c2", reverse: true } },
  { request: "the music is way too loud", tool: "update_audio", args: { id: "au1", volume: 0.4 }, tol: 0.4 },
  { request: "fade the music in and out", tool: "update_audio", args: { id: "au1" } },
  { request: "duck the music under the voice", tool: "update_audio", args: { id: "au1" } },
  { request: "push in on the market clip", tool: "set_framing", args: { clipId: "c2" } },
  { request: "the airport clip is too dark", tool: "set_color_grade", args: { clipId: "c1" } },
  { request: "punch up the blues in the sunset shot", tool: "set_color_hsl", args: { clipId: "c3", band: "blue" } },

  // ── the guards: these must take the model ────────────────────────────
  { request: "set the music to exactly 40%", tool: null },
  { request: "make the sunset clip exactly 2.5 seconds long", tool: null },
  { request: "trim the airport clip to 4.2s", tool: null },
  { request: "slow every clip down", tool: null },
  { request: "mute all the clips", tool: null },
  { request: "put a crossfade on every cut", tool: null },
  { request: "delete the short ones", tool: null },
  { request: "fix the captions", tool: null },
  { request: "make this look better", tool: null },
  { request: "cut out all the filler words", tool: null },
  { request: "add subtitles", tool: null },
  { request: "how long is my cut?", tool: null },
  { request: "hi", tool: null },
  { request: "generate a shot of the airport at night", tool: null },
  { request: "the market clip feels off — make me a better version, more of a golden-hour sunset", tool: null },
  { request: "give me another take of that shot", tool: null },
  { request: "put some music under this", tool: null },
  { request: "read that caption out loud", tool: null },
  { request: "how loud is the music right now?", tool: null },
  { request: "write me a caption for instagram", tool: null },
  { request: "tighten the pauses between sentences", tool: null },
  { request: "put the market clip before the airport one", tool: null },
  { request: "get rid of the crossfade — make the market clip pop in instead", tool: null },
  { request: "make the airport clip warmer and crush the blacks a little", tool: null },
  { request: "trim the airport clip and put a title over it", tool: null },
  { request: "ease the sunset clip into slow motion at the end", tool: null },
];
