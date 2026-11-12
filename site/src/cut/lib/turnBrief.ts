import { askJudge, noul, type Entry, type NoulAnswer } from "./judge";
import type { PostFn } from "./pi/donkeyStream";
import type { CutJudgeSettings } from "./turnQuality";

// The brief: everything one turn was told to do — the typed ask, and the body
// of every note it read for it — split once into a checklist and held up
// against the editor when the turn signs off. A pasted prompt, an @-mentioned
// guide and a one-line ask all come out the same shape. The split is a model
// call with typed output; each item is then judged against the editor in
// measured fields, and an item left undone sends the turn back with it named.

type BriefKind = "once" | "throughout" | "verify";

export interface BriefItem {
  id: string;
  what: string;
  kind: BriefKind;
}

const BRIEF_KINDS: readonly BriefKind[] = ["once", "throughout", "verify"];

// The model role that splits a brief; the server resolves it to an id.
const SPLIT_ROLE = "fastDecision";

// Characters of brief one split reads, and the items one turn is held to.
const BRIEF_CAP = 16_000;
const ITEMS_MAX = 24;

// Editor items listed to the judge; the counts and spans cover the rest.
const LISTED_MAX = 40;
const OFF_TIMELINE_MAX = 20;

// The style fields a text's measure carries, as the editor context names them.
const TEXT_STYLE = ["start", "end", "x", "y", "size", "font", "weight", "color", "shadow", "plate", "wrapWidth", "anim"] as const;

const SPLIT_INSTRUCTIONS = [
  "You read the brief a person gave the AI assistant inside a video editor and list every requirement the finished project has to meet.",
  "The brief is the person's ask, as they typed it, and any notes the assistant read for it. A note's steps are requirements only when the ask tells the assistant to follow or apply that note; otherwise the note is material the ask's own requirements draw on.",
  "Write one item per requirement, in the brief's order, as a short instruction in the brief's own terms. Keep names, numbers, styles and asset names exactly as written.",
  "Tag each item with its kind:",
  "- once: one change at one place or one setting. Add this title, set the clip volume to 120%, write the description.",
  "- throughout: something that holds across the whole video or recurs through it. Graphics moving at all times, music under the cut, a sound on each graphic that appears.",
  "- verify: a check the assistant runs on its own work by watching or listening, then fixes. Play back the joins, check the trims against the audio.",
  "A script, a transcript, background and reference material are inputs; list what the brief asks to be done with them.",
  "Return an empty list when the brief asks for nothing to be made.",
].join("\n");

const SPLIT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          what: { type: "string" },
          kind: { type: "string", enum: [...BRIEF_KINDS] },
        },
        required: ["what", "kind"],
      },
    },
  },
  required: ["items"],
};

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** One note the turn read, as the brief carries it. */
export interface BriefNote {
  title: string;
  body: string;
}

/** The brief as the split reads it: the ask under its own heading, and each
 * note under its title, so the split can tell what the person typed. */
function briefText(ask: string, notes: BriefNote[]): string {
  const parts = [`The ask, as the person typed it:\n${ask}`];
  for (const n of notes) {
    parts.push(`A note the assistant read, titled "${n.title}":\n${n.body}`);
  }
  return parts.join("\n\n").slice(0, BRIEF_CAP);
}

/** The brief split into its checklist. Throws when the call fails, and the
 * caller decides what a missing checklist means. */
export async function splitBrief(post: PostFn, ask: string, notes: BriefNote[], signal?: AbortSignal): Promise<BriefItem[]> {
  const res = await post(
    {
      donkeyProvider: "gemini",
      model: SPLIT_ROLE,
      instructions: SPLIT_INSTRUCTIONS,
      input: [{ role: "user", content: [{ text: briefText(ask, notes) }] }],
      text: { format: { type: "json_schema", schema: SPLIT_SCHEMA } },
    },
    signal
  );
  if (!res.ok) {
    throw new Error(`brief split ${res.status}`);
  }

  const body = (await res.json()) as { output_text?: string };
  const parsed = JSON.parse(body.output_text ?? "") as unknown;
  const raw = isRec(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
  return raw
    .filter(isRec)
    .filter((i) => typeof i.what === "string" && i.what.trim() && BRIEF_KINDS.includes(i.kind as BriefKind))
    .slice(0, ITEMS_MAX)
    .map((i, n) => ({ id: `item${n + 1}`, what: (i.what as string).trim(), kind: i.kind as BriefKind }));
}

interface Span {
  from: number;
  to: number;
}

/** Seconds a set of spans covers, overlaps counted once. */
function covered(spans: Span[]): number {
  const sorted = spans.filter((s) => s.to > s.from).sort((a, b) => a.from - b.from);
  let total = 0;
  let reach = -Infinity;
  for (const s of sorted) {
    if (s.to <= reach) {
      continue;
    }
    total += s.to - Math.max(s.from, reach);
    reach = s.to;
  }
  return total;
}

/** The longest stretch of the cut no span covers. */
function longestBare(spans: Span[], duration: number): { from: number; to: number } | null {
  const sorted = spans.filter((s) => s.to > s.from).sort((a, b) => a.from - b.from);
  let best: { from: number; to: number } | null = null;
  let reach = 0;
  const consider = (from: number, to: number) => {
    if (to - from > (best ? best.to - best.from : 0)) {
      best = { from: round2(from), to: round2(to) };
    }
  };
  for (const s of sorted) {
    consider(reach, Math.min(s.from, duration));
    reach = Math.max(reach, s.to);
  }
  consider(reach, duration);
  return best;
}

/** One graphic over the picture, as the measures read it. */
interface Graphic extends Span {
  kind: string;
  name: string;
  moving: boolean;
}

/** Everything drawn over track 0: elements, and the video layers above it. A
 * layer moves when it plays video or carries keyframes; an element moves when
 * it animates in, out or across. */
function graphicsOf(c: Record<string, unknown>): Graphic[] {
  const media = Array.isArray(c.media) ? c.media.filter(isRec) : [];
  const typeOf = new Map(media.map((m) => [m.name, m.type]));
  const overlays = Array.isArray(c.overlays) ? c.overlays.filter(isRec) : [];
  const layers = Array.isArray(c.overlayVideo) ? c.overlayVideo.filter(isRec) : [];

  // Elements: text, shapes, stickers, effects.
  const elements = overlays
    .filter((o) => !o.hidden)
    .map((o) => ({
      kind: typeof o.kind === "string" ? o.kind : "text",
      name: typeof o.name === "string" ? o.name : "",
      from: num(o.start),
      to: num(o.end),
      moving: !!o.anim || (Array.isArray(o.keyframes) && o.keyframes.length > 0),
    }));

  // Video layers: pictures and footage placed above track 0.
  const placed = layers
    .filter((l) => !l.hidden)
    .map((l) => ({
      kind: "layer",
      name: typeof l.asset === "string" ? l.asset : "",
      from: num(l.start),
      to: num(l.start) + num(l.len),
      moving: typeOf.get(l.asset) === "video" || (Array.isArray(l.keyframes) && l.keyframes.length > 0),
    }));
  return [...elements, ...placed];
}

/** The editor in the numbers a brief is checked against: how much of the cut
 * carries graphics and how much of that moves, the sound under it, the
 * captions, the publish details, and the media nothing on the timeline uses.
 * Built from the same snapshot the model reads, so the page, the engine and
 * the worker measure alike. */
export function briefMeasures(context: unknown): Entry {
  const c = isRec(context) ? context : {};
  const project = isRec(c.project) ? c.project : {};
  const duration = num(project.duration);
  const track = Array.isArray(c.videoTrack) ? c.videoTrack.filter(isRec) : [];
  const soundtrack = Array.isArray(c.soundtrack) ? c.soundtrack.filter(isRec) : [];
  const media = Array.isArray(c.media) ? c.media.filter(isRec) : [];
  const subtitles = isRec(c.subtitles) ? c.subtitles : {};
  const publish = isRec(c.publish) ? c.publish : {};
  const graphics = graphicsOf(c);
  const moving = graphics.filter((g) => g.moving);
  const bare = longestBare(graphics, duration);

  // Names on the timeline, so media that sits unused can be counted.
  const used = new Set(
    [...track, ...soundtrack, ...(Array.isArray(c.overlayVideo) ? c.overlayVideo.filter(isRec) : [])].map((i) => i.asset)
  );
  // The values a brief names most often: how its shown text is set, and how
  // loud its clips play. Clips at 100% carry no volume; a muted clip plays at 0.
  const overlays = Array.isArray(c.overlays) ? c.overlays.filter(isRec) : [];
  const texts = overlays
    .filter((o) => o.kind === "text" && !o.hidden)
    .slice(0, LISTED_MAX)
    .map((o) => ({
      text: typeof o.text === "string" ? o.text.slice(0, 80) : "",
      ...Object.fromEntries(TEXT_STYLE.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])),
    }));
  const clipVolumes = [...new Set(track.map((t) => (t.muted ? 0 : t.volume === undefined ? 1 : num(t.volume))))].sort(
    (a, b) => a - b
  );

  const caption = typeof publish.caption === "string" ? publish.caption : "";
  const tags = typeof publish.tags === "string" ? publish.tags : "";

  return {
    duration,
    videoClips: track.length,
    graphics: {
      count: graphics.length,
      secondsCovered: round2(covered(graphics)),
      secondsMoving: round2(covered(moving)),
      longestStretchWithout: bare,
      items: graphics.slice(0, LISTED_MAX).map((g) => ({
        kind: g.kind,
        name: g.name.slice(0, 80),
        from: round2(g.from),
        to: round2(g.to),
        moving: g.moving,
      })),
    },
    texts,
    clipVolumes,
    soundtrack: soundtrack.slice(0, LISTED_MAX).map((a) => ({
      asset: typeof a.asset === "string" ? a.asset : "",
      start: num(a.start),
      len: num(a.len),
      in: num(a.in),
      volume: num(a.volume),
    })),
    captionCues: num(subtitles.count),
    publish: { caption, tags, characters: caption.length + tags.length },
    mediaOffTimeline: media
      .filter((m) => !used.has(m.name))
      .slice(0, OFF_TIMELINE_MAX)
      .map((m) => (typeof m.name === "string" ? m.name : "")),
  };
}

/** What the turn has done, as the brief check reads it. */
interface BriefWork {
  items: BriefItem[];
  /** Tools that ran without failing, with how many times each did. */
  ran: Record<string, number>;
  reply: string;
  editor: Entry;
}

const REPLY_CAP = 1500;

// What meets an item of each kind. Each question carries only its own kind's
// test, so a judgment of one item never weighs another kind's bar.
const ITEM_MET: Record<BriefKind, { true: string; false: string }> = {
  once: {
    true: "`editor` shows it in place with the values it names. Where `editor` has no field for it, `ran` holds the call that makes it.",
    false: "Nothing in `editor` or `ran` shows it, or its values in `editor` differ from the ones it names.",
  },
  throughout: {
    true: "It holds over nearly all of `editor.duration`: graphics through `editor.graphics` (seconds covered and moving close to the duration, no long stretch without), sound through `editor.soundtrack`, other work through `ran`.",
    false: "It covers only a slice of the cut, leaves a long stretch without, or nothing in `editor` or `ran` shows it.",
  },
  verify: {
    true: "`ran` holds watch or listen calls over the cut.",
    false: "No watch or listen call ran.",
  },
};

/** One question per item: is it met in the editor and the calls behind it? */
function itemQuestions(items: BriefItem[]) {
  return Object.fromEntries(
    items.map((item) => [
      item.id,
      noul(
        `Is this brief item met by the project as it stands? "${item.what}" Judge \`editor\` and \`ran\`; the reply's account counts for nothing on its own.`,
        ITEM_MET[item.kind]
      ),
    ])
  );
}

/** The items the project does not meet yet. Throws when the judgment cannot
 * be asked. */
export async function openItems(
  judge: PostFn,
  work: BriefWork,
  settings: CutJudgeSettings,
  signal?: AbortSignal
): Promise<BriefItem[]> {
  const state: Entry = {
    brief: Object.fromEntries(work.items.map((i) => [i.id, { what: i.what, kind: i.kind }])),
    ran: work.ran,
    reply: work.reply.slice(0, REPLY_CAP),
    editor: work.editor,
  };
  const { answers } = await askJudge(judge, state, itemQuestions(work.items), signal);
  const scored = answers as Record<string, NoulAnswer | undefined>;
  return work.items.filter((i) => (scored[i.id]?.noul ?? 1) < settings.qualityBriefDone);
}

/** The instruction a turn with open items goes back to work on. It names
 * each item, and for an item that runs through the cut it carries the
 * measures, so the next pass starts from where the graphics stop. */
export function briefSteer(open: BriefItem[], editor: Entry, prefix: string): string {
  const list = open.map((i, n) => `${n + 1}. (${i.kind}) ${i.what}`).join("\n");
  const lines = [
    `${prefix} Not yet. The brief this turn works from has items the project does not meet:`,
    list,
    "Do them with tools now, keeping everything already built.",
  ];

  // A throughout item is planned across the timeline before it is built.
  if (open.some((i) => i.kind === "throughout")) {
    const g = isRec(editor) && isRec(editor.graphics) ? editor.graphics : {};
    const bare = isRec(g.longestStretchWithout) ? g.longestStretchWithout : null;
    const duration = isRec(editor) ? num(editor.duration) : 0;
    lines.push(
      "For an item that runs through the whole video, plan first: walk the timeline from start to end, decide what is on screen and how it moves in each stretch, and what it sounds like when it lands. Then build that plan.",
      `Graphics now cover ${num(g.secondsCovered)}s of the ${duration}s cut, ${num(g.secondsMoving)}s of it moving` +
        (bare ? `, and nothing sits over the picture from ${num(bare.from)}s to ${num(bare.to)}s.` : ".")
    );
  }

  // A verify item is a look or a listen at the cut, then the fix.
  if (open.some((i) => i.kind === "verify")) {
    lines.push("For a check item, watch or listen to the cut where it applies, then fix what you find.");
  }
  lines.push("If the editor cannot do an item, say so plainly when you reply, and name any item still open.");
  return lines.join("\n");
}
