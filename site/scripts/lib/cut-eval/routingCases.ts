// The routing eval's labelled turns: what the judge should decide for each.
// `skill` is the document a careful editor opens first (null when none, a
// list when more than one reads right), and
// `areas` are the tool areas the ask cannot be finished without — the eval
// checks that every gold area is declared, so a routed turn never dead-ends.
// `intent` pins the gate side where it matters.

export interface RoutingCase {
  request: string;
  recent?: { role: "user" | "assistant"; text: string }[];
  skill: string | (string | null)[] | null;
  areas: string[];
  intent?: "chat" | "simple" | "complex";
}

export const routingCases: RoutingCase[] = [
  // ── uncovered turns: no skill, no work ────────────────────────────────
  { request: "hi", skill: null, areas: [], intent: "chat" },
  { request: "thanks, that's perfect", skill: null, areas: [], intent: "chat" },
  { request: "ok bye", skill: null, areas: [], intent: "chat" },
  { request: "how long is my cut right now?", skill: null, areas: [], intent: "simple" },
  { request: "what's on the timeline?", skill: null, areas: [], intent: "simple" },
  { request: "which clips have captions?", skill: null, areas: [], intent: "simple" },
  { request: "write me a caption for tiktok about this beach day", skill: null, areas: [], intent: "simple" },
  { request: "give me three title ideas for this video", skill: null, areas: [] },
  // ── single plainly named tools: no skill ──────────────────────────────
  { request: "mute the second clip", skill: null, areas: ["timeline"], intent: "simple" },
  { request: "delete the last title", skill: null, areas: ["timeline"], intent: "simple" },
  { request: "rename the project to Beach Day", skill: null, areas: ["top_bar"], intent: "simple" },
  { request: "switch the aspect to 16:9", skill: null, areas: ["top_bar"], intent: "simple" },
  { request: "undo that", skill: null, areas: ["editor"], intent: "simple" },
  { request: "hide track 1", skill: null, areas: ["timeline"], intent: "simple" },
  { request: "seek to 12 seconds", skill: null, areas: ["preview"], intent: "simple" },
  { request: "show me the frame at 4 seconds", skill: null, areas: ["preview"], intent: "simple" },
  { request: "open the export dialog", skill: null, areas: ["top_bar"], intent: "simple" },
  { request: "select the first clip", skill: null, areas: ["timeline"], intent: "simple" },
  {
    request: "yes do it",
    recent: [
      { role: "user", text: "could you clean up my captions? lots of filler words" },
      { role: "assistant", text: "Happy to — I'd tidy the five cues on track 0, dropping the ums and uhs. Want me to go ahead?" },
    ],
    skill: [null, "audio-and-subtitles"],
    areas: ["subtitles"],
    intent: "simple",
  },
  // ── editor-overview ───────────────────────────────────────────────────
  { request: "where do generated images end up, the media tab?", skill: ["editor-overview", "media-and-library"], areas: [] },
  { request: "how do the tracks stack, which one is in front?", skill: ["editor-overview", "timeline-editing"], areas: [] },
  // ── timeline-editing ──────────────────────────────────────────────────
  { request: "move the third clip to the start and close the gap it leaves", skill: "timeline-editing", areas: ["timeline"] },
  { request: "group the intro clips so they move together", skill: "timeline-editing", areas: ["timeline"] },
  { request: "put the b-roll on a track above the interview from 5 to 9 seconds", skill: "timeline-editing", areas: ["timeline"] },
  // ── color-grading ─────────────────────────────────────────────────────
  { request: "make the second clip warmer", skill: "color-grading", areas: ["color"], intent: "simple" },
  { request: "the footage looks flat and milky, fix the blacks", skill: "color-grading", areas: ["color"] },
  { request: "match the color of my clip to this reference", skill: "color-grading", areas: ["color"] },
  // ── background-removal ────────────────────────────────────────────────
  { request: "remove the background from the presenter clip", skill: "background-removal", areas: ["removal"] },
  { request: "cut me out of this and put the city behind me", skill: "background-removal", areas: ["removal"] },
  { request: "the cutout has rough hair edges, refine it", skill: "background-removal", areas: ["removal"] },
  // ── watching-and-cutting ──────────────────────────────────────────────
  { request: "cut out the dead air", skill: "watching-and-cutting", areas: ["timeline"], intent: "complex" },
  { request: "cut the filler words out of my video", skill: "watching-and-cutting", areas: ["timeline"], intent: "complex" },
  { request: "clip the best moment from the interview", skill: "watching-and-cutting", areas: ["timeline"] },
  { request: "split wherever the scene changes", skill: "watching-and-cutting", areas: ["timeline"], intent: "complex" },
  // ── transitions-and-fades ─────────────────────────────────────────────
  { request: "add a crossfade between the first two clips", skill: "transitions-and-fades", areas: ["transitions"], intent: "simple" },
  { request: "fade the last clip out to black", skill: "transitions-and-fades", areas: ["transitions"] },
  { request: "make the title slide in", skill: "transitions-and-fades", areas: ["animation"] },
  // ── graphics ──────────────────────────────────────────────────────────
  { request: "add a title that says Summer 2026 in the top third with a dark plate", skill: "graphics", areas: ["timeline"] },
  { request: "put a rounded rectangle behind the title", skill: "graphics", areas: ["elements"] },
  { request: "build a 2x2 grid of my four clips like this reference", skill: "graphics", areas: ["timeline", "inspector"], intent: "complex" },
  { request: "add a sticker of a smiling sun in the corner", skill: "graphics", areas: ["elements"] },
  // ── text-videos ───────────────────────────────────────────────────────
  { request: "build a lyric video from this song", skill: "text-videos", areas: ["subtitles", "timeline"], intent: "complex" },
  { request: "make a quote card video with the three quotes I pasted", skill: "text-videos", areas: ["timeline"], intent: "complex" },
  { request: "kinetic type of what he says, make it punchy", skill: "text-videos", areas: ["timeline", "subtitles"], intent: "complex" },
  // ── text-creativity ───────────────────────────────────────────────────
  { request: "the text looks boring and samey, make it creative", skill: "text-creativity", areas: ["inspector", "animation"] },
  { request: "give the words more life, every line is dead center", skill: "text-creativity", areas: ["inspector"] },
  // ── audio-and-subtitles ───────────────────────────────────────────────
  { request: "make the music as loud as the voice", skill: "audio-and-subtitles", areas: ["inspector"] },
  { request: "add a voiceover reading my script in a warm older man's voice", skill: "audio-and-subtitles", areas: ["audio"] },
  { request: "translate the captions to Korean on a second track", skill: "audio-and-subtitles", areas: ["subtitles"] },
  { request: "the captions are off from the speech, retime them", skill: "audio-and-subtitles", areas: ["subtitles"] },
  // ── ai-generation ─────────────────────────────────────────────────────
  { request: "generate a 5 second clip of a rainy tokyo street at night", skill: "ai-generation", areas: ["video_gen"] },
  { request: "find me some stock footage of a busy city", skill: "ai-generation", areas: ["stock"], intent: "simple" },
  { request: "make an image of a golden retriever on a surfboard", skill: "ai-generation", areas: ["image_gen"] },
  { request: "add a whoosh at the cut", skill: ["ai-generation", "audio-and-subtitles"], areas: ["stock"] },
  { request: "import this tiktok link into my project", skill: "ai-generation", areas: [] },
  { request: "the beach clip feels off — make me a better version, more of a golden-hour sunset", skill: "ai-generation", areas: ["video_gen"] },
  // ── scene-productions ─────────────────────────────────────────────────
  { request: "turn my narration into a smooth 2D cartoon", skill: "scene-productions", areas: ["scene"] },
  { request: "make a narrated three-shot story about a kite that gets away", skill: "scene-productions", areas: ["scene"], intent: "complex" },
  { request: "regenerate shot 2 with the boy holding the kite", skill: "scene-productions", areas: ["scene"] },
  // ── editing-taste ─────────────────────────────────────────────────────
  { request: "tighten this up and make it flow better", skill: ["editing-taste", "watching-and-cutting"], areas: ["timeline"], intent: "complex" },
  { request: "should I put a transition on every cut?", skill: ["editing-taste", "transitions-and-fades"], areas: [] },
  // ── media-and-library ─────────────────────────────────────────────────
  { request: "save this cutout to my library", skill: "media-and-library", areas: ["side_panel"] },
  { request: "move the generated voiceover into media", skill: "media-and-library", areas: ["side_panel"] },
  { request: "save this project as a template", skill: "media-and-library", areas: ["library"] },
  // ── replicating-a-project ─────────────────────────────────────────────
  { request: "replicate this project with my footage: https://donkeycut.com/app/p/abc123", skill: "replicating-a-project", areas: [], intent: "complex" },
  { request: "bring over the title style from https://donkeycut.com/s/xyz", skill: "replicating-a-project", areas: [] },
  // ── publish-and-export ────────────────────────────────────────────────
  { request: "export a 4K version for youtube", skill: "publish-and-export", areas: ["top_bar"] },
  { request: "set the tiktok caption and tags for this", skill: "publish-and-export", areas: ["side_panel"] },
  { request: "export just the selected part as prores", skill: "publish-and-export", areas: ["top_bar"] },
];
