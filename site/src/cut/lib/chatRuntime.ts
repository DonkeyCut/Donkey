import { z } from "zod";

// Chat continuity: project and conversation refresh cadence, scene ownership
// expiry, and the saved engine transcript size.
export const CHAT_RUNTIME = { syncIntervalMs: 5000, sceneLeaseMs: 30000, journalBytes: 8388608 };

// The tab sends its chat runtime with every engine turn and scene lease, and
// engines already installed require it, so the wire keeps carrying it.
export const chatRuntimeSchema = z.object({
  syncIntervalMs: z.number().int().min(1000).max(30000),
  sceneLeaseMs: z.number().int().min(15000).max(120000),
  journalBytes: z.number().int().min(1048576).max(33554432),
}).strict();

// ChatGPT editor command polling cadence and maximum failure backoff.
export const CHATGPT_POLLING = { pollMs: 1000, hiddenPollMs: 3000, maxBackoffMs: 60000 };

// Thresholds for the typed judgments that route a chat turn, run a one-action
// turn with no model round, hold a turn back until its work is finished and
// its reply true to it, re-place the messages waiting in the tray, pick the
// items a sweep touches, rank stock, find filler words, and resolve voices.
export const CUT_JUDGE = {
  // Preload the skill the judge picks for the turn; off leaves the model to
  // read skills on its own.
  skillSuggestion: true,
  // The reference-need probability below which no skill is attached.
  skillGate: 0.4,
  // The winning skill's own fit below which it is dropped.
  skillFits: 0.3,
  // Declare only the tool areas the judge routes to; off declares the whole
  // catalog on every turn.
  toolRouting: true,
  // An area's probability at or above which its tools are declared.
  toolArea: 0.2,
  // How long the first model round waits for the judge before going out with
  // the full catalog and no skill. Set above the judgment's slowest turns: a
  // round that goes out early is the one a chat or complex verdict then
  // throws away.
  judgeWaitMs: 1000,
  // A stock candidate's fit below which it is left out of a search.
  stockFit: 0.5,
  // A transcript word's disfluency probability at or above which find_filler
  // reports it.
  fillerCut: 0.5,
  // The confidence below which a described voice falls back to the default.
  voicePick: 0.4,
  // How often a running turn re-places the messages waiting in the tray
  // against the work it has done since; 0 places them once, at send.
  queueRetriageMs: 4000,
  // Run a turn the judgment settles to one known action with no model round
  // at all; off sends every turn through the chat loop.
  instantAction: true,
  // The chosen action's own probability below which the turn takes the loop
  // instead. The floors below do the same for each argument.
  instantFloor: 0.5,
  instantTarget: 0.5,
  instantEnum: 0.5,
  // A style, look or direction the request left open: several good answers
  // split the probability, so the winner clears less.
  instantPick: 0.15,
  instantLevel: 0.3,
  // A yes/no argument has to be this decisive in one direction.
  instantBool: 0.7,
  // An ask that names an exact figure, acts on more than one item, leaves a
  // second edit undone, or wants the shot itself remade goes to the model at
  // or above these.
  instantExact: 0.4,
  instantMulti: 0.4,
  instantLeftover: 0.5,
  instantRemake: 0.3,
  // A candidate's fit below which a described sweep leaves it out.
  sweepFit: 0.5,
  // Judge the turn's own work before it closes; off lets a turn sign off on
  // whatever it did.
  qualityGate: true,
  // The probabilities below which the work is judged unfinished, the footage
  // under-watched, and the reply wider than the record.
  qualityFinished: 0.5,
  qualitySeen: 0.5,
  qualityHonest: 0.5,
  // The probability above which the ask is taken to want the project changed,
  // which lets a turn that changed nothing be sent to build.
  qualityWantsChange: 0.5,
  // The probability above which the reply is taken to ask the one question an
  // ambiguous ask needs answered, which closes the turn on that question.
  qualityAsksBack: 0.5,
  // The probability above which the ask is taken to turn on how the source
  // sounds, which makes unplayed seconds a gap worth a round.
  qualityHears: 0.6,
  // The probability above which on-screen text is taken to be the source's
  // own narration, which puts its words in the transcript and leaves only
  // their treatment to be read off the frames.
  qualityCaptionsSpeak: 0.7,
  // Seconds of close reading that settle how a spoken caption track is set,
  // once the words are known from the transcript.
  qualityTreatmentSeconds: 8,
  // How many times one turn may be sent back to work by the gate.
  qualityRounds: 3,
};

// How a talk or an interview is read for the moments worth cutting a short
// from.
export const CUT_CLIP = {
  // A pause this long ends a sentence when the punctuation does not.
  pauseBreakSeconds: 0.6,
  // What a clip may run. The sweep aims at the target and accepts anything
  // between the bounds, ending on a sentence.
  minSeconds: 18,
  targetSeconds: 45,
  maxSeconds: 75,
  // How far apart the wide sweep's candidate starts sit. Smaller reads more
  // of the source and costs more questions.
  strideSeconds: 12,
  // How many of the sweep's best earn the close read.
  shortlist: 14,
  // Standing alone and landing are requirements: a stretch that needs what
  // came before it, or that trails off into the next thing, is not a clip
  // however well it opens. Below either floor it is not offered.
  standaloneFloor: 0.35,
  payoffFloor: 0.5,
  // What orders the ones that qualify.
  standaloneWeight: 0.4,
  hookWeight: 0.35,
  payoffWeight: 0.25,
  // The composite below which a moment is not offered at all.
  rankFloor: 0.45,
  // Second beats considered per clip, and the probability one has to reach
  // to be cut in behind the first.
  pairsPerClip: 3,
  followsFloor: 0.6,
};

// How hands, heads and people are tracked through a clip.
export const CUT_TRACKING = {
  // Tracked frames per second of the span, and the most frames one track
  // reads; a longer span samples more sparsely.
  sampleFps: 30,
  maxFrames: 1200,
  // The decoded frame's long side the landmarkers read.
  longSide: 1280,
  // Detection, presence and tracking confidence floors.
  minConfidence: 0.5,
  // One-euro smoothing: the cutoff (Hz) a still target settles at, and how
  // fast the cutoff rises with speed.
  smoothCutoff: 1.5,
  smoothBeta: 20,
  // A dropout this short is bridged; a longer one hides the shape.
  bridgeSeconds: 0.25,
  // How far, in frame fractions, a dropped key may sit from the line its
  // neighbors draw.
  keyTolerance: 0.0015,
};

// How long a note sits still after the last keystroke before it saves.
export const CUT_NOTES = { autosaveMs: 800 };

// The pause before each automatic retry of an upload the connection dropped;
// the browser's reconnect retries it too.
export const CUT_UPLOADS = { resumeDelaysMs: [5000, 20000, 60000] as readonly number[] };
