import type { UIMessage } from "ai";
import type { Settings } from "@/lib/config/registry";
import {
  AI_SKILL_AREAS,
  AI_SKILL_BLURBS,
  AI_SKILL_INDEX,
  skillTitle,
  TOOL_AREA_NAMES,
  TOOL_AREAS,
} from "@/cut/server/ai/catalog";
import { choice, noul, type ChoiceAnswer, type Entry, type NoulAnswer } from "./judge";

// The chat harness's understanding boundary for one composer turn: one typed
// judgment over the newest message, the recent turns, and a thin slice of the
// editor answers three things at once — how big the ask is (chat / simple /
// complex), which skill document the model should read first, and which tool
// areas the turn needs — and the harness routes deterministically on the
// probabilities under the thresholds in the `cutJudge` setting. A "chat" turn
// runs with no tool declarations at all, so unsolicited edits are impossible
// by construction; a "simple" turn keeps the light chat model; a "complex"
// turn runs on the full model. The route is composed here, in code, from the
// answers; nothing reads the user's words.

export type TurnIntent = "chat" | "simple" | "complex";

export interface TurnRoute {
  intent: TurnIntent;
  /** The skill document attached to the turn, or null for none. */
  skill: string | null;
  /** The tool areas declared to the turn. */
  areas: string[];
}

export type CutJudgeSettings = Settings["cutJudge"];

/** The judge's questions, built once: the roster of skills and areas is the
 * catalog's, so a new skill or tool module joins the judgment on its own. */
export const TURN_JUDGE_QUESTIONS = {
  intent: choice(
    "Judge only the newest user message, `request`, with `recent` as context. What does it ask of the AI assistant built into a video editor?",
    {
      chat: "Pure social filler that requests nothing: a greeting, thanks, a sign-off, an acknowledgement.",
      simple:
        "One self-contained ask: a single edit, a single generation, or a question to answer. A terse follow-up (\"yes\", \"do it\", \"the second one\") that confirms one pending action is simple.",
      complex:
        "A composed job: several edits across the timeline, cutting or reorganizing many clips, assembling media into a cut, building a whole video from a script, a song, or pasted text (a lyric video, quote cards, kinetic type), or anything needing a plan across steps. A sweep phrased as one ask still fans out into many cuts (removing filler words, tightening silences, cutting every pause). An edit aimed at \"this clip / that one / it\" with no named target, or whose targets are picked by description (\"the grey ones\", \"the short clips\"), takes the full model.",
    },
  ),
  skill: choice(
    "Which skill document would a careful editor open before acting on `request`? Each document teaches one area of the editor: its settings, where they live, and how they behave.",
    Object.fromEntries([
      ["none", "No document covers this request, or the request needs none: a greeting, a question answered from the state, an edit a single plainly named tool performs."],
      ...AI_SKILL_INDEX.map((name) => [name, `${skillTitle(name)}. ${AI_SKILL_BLURBS[name] ?? ""}`]),
    ]) as Record<string, Entry>,
  ),
  unresolved_target: noul(
    "Does `request` aim an edit at an item it points to without naming — \"that clip\", \"it\", \"the one\", \"those\" — which neither `recent` nor `editor.selection` identifies?",
    {
      true: "The target is pointed at and nothing in the conversation or the selection says which item it is.",
      false: "The target is named, described, selected, or was the subject of the recent turns; or the request is an undo, a redo, a confirmation, or edits nothing.",
    },
  ),
  needs_reference: noul(
    "Would the assistant need to read a reference document about this area of the editor to do `request` well?",
    {
      true: "The result depends on settings, modes, defaults, or a flow the tool descriptions do not spell out: grading, transitions, captions, voiceovers, generation, scene productions, graphics, exports, replicating a project, a taste question.",
      false: "One plainly named action — mute, delete, hide, seek, undo, select, rename, set the aspect, open a dialog — or a fact read off the editor state, such as the cut's length or what is on the timeline.",
    },
  ),
  ...Object.fromEntries(
    AI_SKILL_INDEX.map((name) => [
      `fits::${name}`,
      noul(`Does the skill "${skillTitle(name)}" document the settings or the flow that \`request\` needs?`, {
        true: AI_SKILL_BLURBS[name] ?? skillTitle(name),
        false: "The request does not involve this area, or needs nothing from it.",
      }),
    ]),
  ),
  ...Object.fromEntries(
    TOOL_AREA_NAMES.map((area) => [
      `area::${area}`,
      noul(`Does finishing \`request\` call for the ${area.replace("_", " ")} tools?`, {
        true: TOOL_AREAS[area].blurb,
        false: "The request can be finished without these tools.",
      }),
    ]),
  ),
} as const;

type Answers = {
  intent: ChoiceAnswer<Record<"chat" | "simple" | "complex", string>>;
  skill: ChoiceAnswer<Record<string, string>>;
  unresolved_target: NoulAnswer;
  needs_reference: NoulAnswer;
} & Record<string, NoulAnswer | ChoiceAnswer<Record<string, string>>>;

export type TurnJudgeAnswers = Answers;

const TEXT_CAP = 2000;
const RECENT_TURNS = 5;

/** The state the judge reads: the newest ask, the turns before it, what it
 * attached, and the parts of the editor snapshot that change what an ask
 * means. No urls, no media. */
export function judgeTurnState(messages: UIMessage[], context: unknown): Entry {
  const text = (m: UIMessage) =>
    m.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim()
      .slice(0, TEXT_CAP);
  const last = messages.findLast((m) => m.role === "user");
  const before = last ? messages.slice(0, messages.indexOf(last)) : messages;
  const recent = before
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: text(m) }))
    .filter((t) => t.text)
    .slice(-RECENT_TURNS);
  const meta = (last?.metadata as { attachments?: unknown[] } | undefined)?.attachments;
  const attachments = Array.isArray(meta)
    ? meta.map((a) => {
        const r = (a ?? {}) as Record<string, unknown>;
        return {
          kind: typeof r.kind === "string" ? r.kind : null,
          scope: typeof r.scope === "string" ? r.scope : null,
          name: typeof r.name === "string" ? r.name.slice(0, 120) : null,
        };
      })
    : [];
  return {
    request: last ? text(last) : "",
    recent,
    attachments,
    editor: editorSlice(context),
  };
}

function editorSlice(context: unknown): Entry {
  const c = (context ?? {}) as Record<string, unknown>;
  const project = (c.project ?? {}) as Record<string, unknown>;
  const selection = c.selection as Record<string, unknown> | null | undefined;
  const videoTrack = Array.isArray(c.videoTrack) ? c.videoTrack : [];
  const soundtrack = Array.isArray(c.soundtrack) ? c.soundtrack : [];
  const overlays = Array.isArray(c.overlays) ? (c.overlays as Record<string, unknown>[]) : [];
  const subtitles = (c.subtitles ?? {}) as Record<string, unknown>;
  const tracks = Array.isArray(subtitles.tracks) ? subtitles.tracks : [];
  const media = Array.isArray(c.media) ? c.media : [];
  return {
    aspect: typeof project.aspect === "string" ? project.aspect : null,
    duration: typeof project.duration === "number" ? project.duration : null,
    selection: selection
      ? { kind: typeof selection.kind === "string" ? selection.kind : null, name: typeof selection.name === "string" ? selection.name : null }
      : null,
    clips: videoTrack.length,
    soundtrackClips: soundtrack.length,
    overlayKinds: [...new Set(overlays.map((o) => (typeof o.kind === "string" ? o.kind : "overlay")))],
    captionTracks: tracks.length,
    mediaAssets: media.length,
  };
}

// Only a clear chat withholds the tools; any real weight on complex, or a
// flat read, takes the full model; the rest is the light model.
const CHAT_FLOOR = 0.6;
const COMPLEX_FLOOR = 0.35;
const FLAT_CEILING = 0.45;
const UNRESOLVED_FLOOR = 0.5;

/** The skill the answers name, under the thresholds: the reference need
 * clears the gate, the pick is a real skill, and its own fit clears the
 * floor. Null when the turn wants none or suggestion is off. */
export function pickSkill(answers: TurnJudgeAnswers, settings: CutJudgeSettings): string | null {
  if (!settings.skillSuggestion) return null;
  const pick = answers.skill.choice;
  const fit = (answers[`fits::${pick}`] as NoulAnswer | undefined)?.noul ?? 0;
  return answers.needs_reference.noul >= settings.skillGate &&
    pick !== "none" &&
    AI_SKILL_INDEX.includes(pick) &&
    fit >= settings.skillFits
    ? pick
    : null;
}

/** The route for a turn, composed from the answers under the thresholds. A
 * missing verdict (the call failed) fails open: the full model, no skill,
 * every area. */
export function routeTurn(answers: TurnJudgeAnswers | null, settings: CutJudgeSettings): TurnRoute {
  if (!answers) return { intent: "complex", skill: null, areas: [...TOOL_AREA_NAMES] };

  const p = answers.intent.probabilities;
  // An edit whose target nothing identifies takes the full model, which asks.
  const intent: TurnIntent =
    p.chat >= CHAT_FLOOR
      ? "chat"
      : p.complex >= COMPLEX_FLOOR ||
          Math.max(p.chat, p.simple, p.complex) < FLAT_CEILING ||
          answers.unresolved_target.noul >= UNRESOLVED_FLOOR
        ? "complex"
        : "simple";

  // A composed job gets its reference up front. A simple turn runs on the
  // tool descriptions alone: the light model reads an attached reference as
  // more to do, and the eval shows it over-acting with one.
  const skill = intent === "complex" ? pickSkill(answers, settings) : null;

  let areas: string[];
  if (!settings.toolRouting) {
    areas = [...TOOL_AREA_NAMES];
  } else {
    const wanted = new Set<string>();
    for (const area of TOOL_AREA_NAMES) {
      const a = answers[`area::${area}`] as NoulAnswer | undefined;
      if (a && a.noul >= settings.toolArea) wanted.add(area);
    }
    for (const area of skill ? (AI_SKILL_AREAS[skill] ?? []) : []) wanted.add(area);
    areas = TOOL_AREA_NAMES.filter((a) => wanted.has(a));
  }
  return { intent, skill, areas };
}
