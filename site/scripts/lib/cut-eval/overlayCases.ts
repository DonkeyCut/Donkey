/**
 * Report charts over a talking head, run against the live editor.
 *
 * A real edit went wrong here: every chart sat over a line that never
 * mentions it, the last ran past the cut's end, and the boxes hung off the
 * frame's side. These cases seed the store with a talking-head cut — one take
 * per line, each line in its captions and its source notes — plus the
 * report's pages, and route every editing tool through runAiTool, so the
 * model sees the tool results the editor gives and the graders read the
 * timeline it leaves.
 */

import { buildAiContext } from "../../../src/cut/lib/aiContext";
import { runAiTool } from "../../../src/cut/lib/aiTools";
import { safeAreaOf } from "../../../src/cut/lib/guides";
import { clipLen, totalDuration, useEditor } from "../../../src/cut/lib/store";
import { emptySubtitles, rectOf, type Asset, type VideoClip } from "../../../src/cut/lib/types";
import type { EvalCase } from "./cases";
import { assistantTurn, plainUserTurn, userTurn } from "./fixtures";

// One take per line, trimmed to the speech and cut end to end.
const LINES = [
  { id: "t1", text: "What's it like working at a company that runs on AI agents?", len: 3.2 },
  { id: "t2", text: "Northwind just published a report on how its own teams work now.", len: 4 },
  { id: "t3", text: "First, AI agents now log four times as many hours as the people do.", len: 4.2 },
  { id: "t4", text: "Engineers ship three times as many pull requests as a year ago.", len: 4 },
  { id: "t5", text: "Humans have become the bottleneck.", len: 2 },
  { id: "t6", text: "And it's changing who gets hired.", len: 2.2 },
  { id: "t7", text: "New-grad hires fell from 30 percent to just 12 percent.", len: 3.8 },
  { id: "t8", text: "So is this what every tech job looks like soon?", len: 3 },
] as const;

// Each take's speech starts a second into its source.
const TAKE_IN = 1;
const TAKE_SECONDS = 8;

// The report's pages, in the report's order — which is not the script's.
const PAGES = [
  { id: "p1", page: 1, note: "Cover art: the report's title on a teal grid." },
  { id: "p2", page: 2, note: 'Chart titled "Share of new-grad hires" falling from 30% to 12%.', line: "t7" },
  { id: "p3", page: 3, note: 'Chart titled "Agent hours vs human hours" with agents at 4x.', line: "t3" },
  { id: "p4", page: 4, note: 'Chart titled "Pull requests per engineer" up 3x in a year.', line: "t4" },
] as const;

const CHARTS = PAGES.filter((p) => "line" in p);

// Tools that decode media the eval holds no bytes for; they answer from the
// notes the sources already carry.
const MEDIA_TOOLS = new Set([
  "watch_video",
  "listen_audio",
  "capture_frame",
  "detect_silence",
  "find_filler",
  "detect_beats",
  "measure_level",
  "refine_speech_cuts",
  "compare_to_source",
]);

// How far past an edge a box may sit before it counts as off the frame: a
// pixel of a 1080 frame, and the same slack inside a safe area.
const EDGE_SLACK = 0.002;

function takeAsset(i: number): Asset {
  const line = LINES[i];
  return {
    id: line.id,
    name: `take-${i + 1}.mov`,
    fileName: `take-${i + 1}.mov`,
    type: "video",
    duration: TAKE_SECONDS,
    width: 1080,
    height: 1920,
    url: "",
    watch: {
      ranges: [{ from: 0, to: TAKE_SECONDS }],
      frames: [],
      sceneChanges: [],
      notes: [{ from: 0, to: TAKE_SECONDS, text: `Speaker to camera saying: ${line.text}` }],
    },
    speech: {
      ranges: [{ from: 0, to: TAKE_SECONDS }],
      segments: [{ start: TAKE_IN, end: TAKE_IN + line.len, text: line.text }],
      locale: "en-US",
    },
  } as Asset;
}

function pageAsset(p: (typeof PAGES)[number]): Asset {
  return {
    id: p.id,
    name: `Northwind report (${p.page}/4)`,
    fileName: `page-${p.page}.jpg`,
    type: "image",
    duration: 0,
    width: 2000,
    height: 1125,
    url: "",
    watch: { ranges: [], frames: [], sceneChanges: [], notes: [{ from: 0, to: 0, text: p.note }] },
  } as Asset;
}

/** The cut as it stands after assembly: every take on track 0 in script
 * order with its caption, every report page in the project. `charts` lays
 * the charts on track 1 first, each over its line, in the given box. */
function seed(charts?: { frame: { x: number; y: number; w: number; h: number } }) {
  let t = 0;
  const clips: VideoClip[] = LINES.map((l, i) => {
    const c: VideoClip = { id: `c${i + 1}`, assetId: l.id, track: 0, start: t, in: TAKE_IN, out: TAKE_IN + l.len, muted: false };
    t += l.len;
    return c;
  });
  const starts = new Map(clips.map((c) => [c.assetId, c.start]));
  const overlays: VideoClip[] = charts
    ? CHARTS.map((p, i) => {
        const line = LINES.find((l) => l.id === p.line)!;
        return {
          id: `o${i + 1}`,
          assetId: p.id,
          track: 1,
          start: starts.get(line.id)!,
          in: 0,
          out: line.len,
          muted: false,
          frame: { ...charts.frame },
        };
      })
    : [];
  useEditor.setState({
    projectId: "p-eval-report",
    aspect: "9:16",
    clips: [...clips, ...overlays],
    overlays: [],
    transitions: [],
    audioClips: [],
    guides: [],
    subtitles: {
      ...emptySubtitles(),
      cues: clips.map((c, i) => ({ id: `q${i + 1}`, start: c.start, end: c.start + LINES[i].len, text: LINES[i].text })),
    },
    assets: [...LINES.map((_, i) => takeAsset(i)), ...PAGES.map(pageAsset)],
    selection: null,
  });
}

/** Every call runs on the live editor; media reads answer from the notes. */
function liveSim(seedState: () => void, verify: () => string[]) {
  seedState();
  const sim = (name: string, args: Record<string, unknown>): unknown => {
    if (name === "read_skill" || name === "list_skills") return undefined;
    if (MEDIA_TOOLS.has(name)) {
      return { note: "eval: no picture or sound here — the sources' notes and transcripts in editor_state hold what they show and say.", args };
    }
    return runAiTool(name, args);
  };
  return Object.assign(sim, { verify });
}

const layers = () => useEditor.getState().clips.filter((c) => c.track > 0);
const assetName = (id: string) => useEditor.getState().assets.find((a) => a.id === id)?.name ?? id;
const lineSpan = (lineId: string) => {
  const c = useEditor.getState().clips.find((x) => x.track === 0 && x.assetId === lineId)!;
  return { start: c.start, end: c.start + clipLen(c) };
};

/** Each chart sits over the line that cites it, and nothing runs past the
 * cut's end. */
function timingNotes(): string[] {
  const notes: string[] = [];
  const cutEnd = totalDuration(useEditor.getState().clips);
  for (const p of CHARTS) {
    const placed = layers().filter((c) => c.assetId === p.id);
    if (placed.length === 0) {
      notes.push(`${assetName(p.id)} was never placed`);
      continue;
    }
    const line = lineSpan(p.line);
    for (const c of placed) {
      const mid = c.start + clipLen(c) / 2;
      if (mid < line.start || mid > line.end)
        notes.push(
          `${assetName(p.id)} plays ${c.start.toFixed(2)}–${(c.start + clipLen(c)).toFixed(2)}s, off its line ${line.start.toFixed(2)}–${line.end.toFixed(2)}s`
        );
    }
  }
  for (const c of layers()) {
    const end = c.start + clipLen(c);
    if (end > cutEnd + 0.05) notes.push(`${assetName(c.assetId)} runs to ${end.toFixed(2)}s, past the cut's end at ${cutEnd.toFixed(2)}s`);
  }
  return notes;
}

/** Every layer's box sits inside `area` (the frame by default). */
function boxNotes(area = { x: 0, y: 0, w: 1, h: 1 }, label = "the frame"): string[] {
  const notes: string[] = [];
  for (const c of layers()) {
    const r = rectOf(c);
    const out =
      r.x < area.x - EDGE_SLACK ||
      r.y < area.y - EDGE_SLACK ||
      r.x + r.w > area.x + area.w + EDGE_SLACK ||
      r.y + r.h > area.y + area.h + EDGE_SLACK;
    if (out)
      notes.push(
        `${assetName(c.assetId)} box x ${r.x.toFixed(3)}..${(r.x + r.w).toFixed(3)}, y ${r.y.toFixed(3)}..${(r.y + r.h).toFixed(3)} leaves ${label}`
      );
  }
  return notes;
}

// The turns before the asks: the script, the brief, and the assembly.
const history = () => [
  plainUserTurn(
    `Here's the script:\n${LINES.map((l) => l.text).join("\n")}\n\nEdit this for TikTok. Each clip delivers one line. Get the diagrams from the Northwind report and use infographics when we talk about numbers.`
  ),
  assistantTurn("I cut the 8 takes in script order, captioned them, and imported the report's four pages into the project."),
];

export function overlayCases(): EvalCase[] {
  return [
    {
      // The ask that went wrong: three charts, each on the line that cites
      // it, none past the end, every box on the frame.
      name: "report-charts-on-their-lines",
      bucket: "multi-tool",
      input: () => [...history(), userTurn("put the diagrams in the video")],
      reply: /chart|diagram|graphic|report/i,
      requiredTools: ["add_overlay_video"],
      get state() {
        return buildAiContext({ chatId: null });
      },
      simulate: () => liveSim(() => seed(), () => [...timingNotes(), ...boxNotes()]),
    },
    {
      // The follow-up: the charts sit on their lines in a box that runs into
      // the platform's UI; every box moves inside the short-form safe area.
      name: "report-charts-into-safe-zones",
      bucket: "multi-tool",
      input: () => [
        ...history(),
        plainUserTurn("put the diagrams in the video"),
        assistantTurn("I placed the three charts over the lines that cite them."),
        userTurn("remember the safe zones"),
      ],
      reply: /safe|zone|chart|diagram/i,
      anyTools: ["update_overlay_video"],
      get state() {
        return buildAiContext({ chatId: null });
      },
      simulate: () =>
        liveSim(
          () => seed({ frame: { x: 0, y: 0.3, w: 1, h: 0.42 } }),
          () => {
            const safe = safeAreaOf(["shortform"], "9:16")!;
            return [...timingNotes(), ...boxNotes(safe, "the short-form safe area")];
          }
        ),
    },
    {
      // The charts hang off the frame's right side, as the real edit left
      // them; the complaint brings every box back onto the frame.
      name: "report-charts-back-on-frame",
      bucket: "multi-tool",
      input: () => [
        ...history(),
        plainUserTurn("put the diagrams in the video"),
        assistantTurn("I placed the three charts over the lines that cite them."),
        userTurn("the images are not fully in the video"),
      ],
      reply: /frame|fit|chart|diagram|image/i,
      anyTools: ["update_overlay_video"],
      get state() {
        return buildAiContext({ chatId: null });
      },
      simulate: () => liveSim(() => seed({ frame: { x: 0.5, y: 0.25, w: 0.75, h: 0.4 } }), () => [...timingNotes(), ...boxNotes()]),
    },
  ];
}
