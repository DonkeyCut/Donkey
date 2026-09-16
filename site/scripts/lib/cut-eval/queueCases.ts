/**
 * The queue triage eval cases. Each case is a running turn — its ask and the
 * tools it has run so far — plus the messages the user sent while it ran,
 * each with the place it must be given: fold (the running turn takes it),
 * spawn (a parallel thread runs it now), queue (it waits for the result).
 */

import type { QueueVerdict, TriageAnchor } from "../../../src/cut/lib/queueTriage";

export interface QueueCase {
  name: string;
  anchor: TriageAnchor;
  /** Rows already in the tray when the triaged ones arrive. */
  waiting?: string[];
  rows: { text: string; expect: QueueVerdict }[];
}

const running = (ask: string, progress: string[] = [], elsewhere: string[] = []): TriageAnchor => ({
  ask,
  progress,
  elsewhere,
});

export const queueCases: QueueCase[] = [
  // Refinements of the running ask fold.
  {
    name: "fold-refine-same-job",
    anchor: running("Cut the silences out of clip 2", ["detect_silence", "split_clip (running)"]),
    rows: [{ text: "also tighten the gaps to 0.2s", expect: "fold" }],
  },
  {
    name: "fold-style-the-title-being-added",
    anchor: running("Add a title that says Welcome at the start", ["add_text"]),
    rows: [{ text: "make it blue and a bit bigger", expect: "fold" }],
  },
  {
    name: "fold-correction",
    anchor: running("Remove the filler words", ["detect_filler", "split_clip", "delete_clip (running)"]),
    rows: [{ text: "actually leave the first um in, it sounds natural", expect: "fold" }],
  },
  {
    name: "fold-question-on-question",
    anchor: running("What's in this video?", ["watch_video (running)"]),
    rows: [{ text: "and how long is it?", expect: "fold" }],
  },
  {
    name: "fold-extra-piece-same-job",
    anchor: running("Add captions to the whole video", ["captions_generate (running)"]),
    rows: [{ text: "and put them near the bottom, not the middle", expect: "fold" }],
  },
  {
    name: "fold-timeline-edit-during-restructure",
    anchor: running("Cut the pauses and tighten the whole video", ["detect_silence", "split_clip", "delete_clip (running)"]),
    rows: [{ text: "add a title card at the start too", expect: "fold" }],
  },

  // Independent, non-colliding work spawns.
  {
    name: "spawn-question-during-edit",
    anchor: running("Remove the filler words", ["detect_filler", "split_clip (running)"]),
    rows: [{ text: "what resolution is the source footage?", expect: "spawn" }],
  },
  {
    name: "spawn-audio-level-during-captions",
    anchor: running("Add captions to the whole video", ["captions_generate (running)"]),
    rows: [{ text: "lower the background music to 20%", expect: "spawn" }],
  },
  {
    name: "spawn-grade-other-clip-during-title",
    anchor: running("Add a title that says Welcome at the start", ["add_text"]),
    rows: [{ text: "warm up the color on the interview clip", expect: "spawn" }],
  },
  {
    name: "spawn-footage-question-during-generation",
    anchor: running("Generate a 5 second intro of a sunrise over the city", ["generate_video (running)"]),
    rows: [{ text: "does the second clip have any speech in it?", expect: "spawn" }],
  },

  // Work that needs the finished result waits.
  {
    name: "queue-export-after",
    anchor: running("Cut the silences out of clip 2", ["detect_silence", "split_clip (running)"]),
    rows: [{ text: "then export it at 1080p", expect: "queue" }],
  },
  {
    name: "queue-share-when-done",
    anchor: running("Remove the filler words", ["detect_filler (running)"]),
    rows: [{ text: "when you're done, share the link with me", expect: "queue" }],
  },
  {
    name: "queue-thumbnail-of-final-cut",
    anchor: running("Cut the pauses and tighten the whole video", ["detect_silence", "split_clip (running)"]),
    rows: [{ text: "after that, grab the best frame for a thumbnail", expect: "queue" }],
  },

  // Look-ahead: several rows placed at once against the turn that just started.
  {
    name: "lookahead-mixed",
    anchor: running("Cut the silences out of clip 2", []),
    rows: [
      { text: "and remove the filler words while you're at it", expect: "fold" },
      { text: "what's the aspect ratio of this project?", expect: "spawn" },
      { text: "then export it", expect: "queue" },
    ],
  },
  {
    name: "lookahead-with-waiting-context",
    anchor: running("Add a title that says Welcome at the start", ["add_text (running)"]),
    waiting: ["then export it"],
    rows: [{ text: "center it", expect: "fold" }],
  },

  // Work running in another chat is a collision too.
  {
    name: "queue-collides-with-other-chat",
    anchor: running("Add captions to the whole video", ["captions_generate (running)"], [
      "Cut the silences and tighten the whole video",
    ]),
    rows: [{ text: "add a sticker at 12 seconds", expect: "queue" }],
  },
];
