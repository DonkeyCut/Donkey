// Everything the landing's static editor replica shows, hardcoded per slide.
// The mock components render exactly this — no stores, no engine. The words
// come from the `mock` catalog, so the fake project reads in the page's
// language; file names and a project's own on-screen text stay as made.
import type { useTranslations } from "next-intl";

/** The `mock` catalog's translator, as the factories below take it. */
export type MockT = ReturnType<typeof useTranslations<"mock">>;


export type MockAspect = "9:16" | "16:9";

export type MockPanelTab =
  | "media"
  | "elements"
  | "effects"
  | "transitions"
  | "video"
  | "image"
  | "audio"
  | "subtitles"
  | "details";

export interface MockResultCard {
  src: string;
  /** Caption under the card; omitted where the real card shows the name only
   * on hover. Also the alt text and list key when present. */
  label?: string;
  /** Duration chip on video results ("4.0s"); omitted on images. */
  duration?: string;
  selected?: boolean;
}

/** Which panel is open on the left: a generate panel, its prompt over its
 * results. Null folds the panel to its icon rail. */
export type MockPanel =
  | { tab: "image" | "video"; prompt: string; results: MockResultCard[] }
  | null;

export interface MockChatMessage {
  role: "user" | "assistant";
  text: string;
  /** The collapsed tool-call row above the message, as the assistant's turn
   * shows its work. */
  toolCalls?: number;
  /** Result cards rendered under the message text. */
  cards?: MockResultCard[];
  /** Cards are 9:16 rather than the default 3:4 / 16:9. */
  portrait?: boolean;
}

export interface MockClip {
  label: string;
  /** Start in timeline seconds. */
  at: number;
  seconds: number;
  /** A poster tiled across the clip, or a frame of the project's clip strip. */
  thumb?: string;
  frame?: number;
  selected?: boolean;
  muted?: boolean;
}

/** An element bar's family, which sets its color as on the real timeline:
 * text purple, elements (shapes and stickers) magenta, effects teal. */
export type MockLaneTone = "text" | "element" | "effect";

/** A bar on an element row or the audio row. */
export interface MockBar {
  label: string;
  /** Start in timeline seconds. */
  at: number;
  seconds: number;
  tone?: MockLaneTone;
  /** Keyframe diamonds, as fractions of the bar's length. */
  keys?: number[];
}

export interface MockProject {
  id: string;
  /** Label on the slide switcher dot. */
  switcherLabel: string;
  name: string;
  aspect: MockAspect;
  panel: MockPanel;
  videoSrc: string;
  videoPoster: string;
  previewCaption: string;
  /** Total timeline length driving ruler ticks and the playhead sweep. */
  timelineSeconds: number;
  /** Element rows above the video track, top row first. */
  lanes: MockBar[][];
  clips: MockClip[];
  /** One image holding a frame per clip side by side, for clips that name a
   * `frame` — a single request for a cut of many short shots. */
  clipStrip?: { src: string; count: number };
  /** Audio rows under the video track. */
  audio: MockBar[][];
  chat: MockChatMessage[];
}

const ASSETS = "/cut/landing";

/** The landing's showcase pair. */
export function mockProjects(t: MockT): MockProject[] {
  return [postersProject(t), railwayProject(t)];
}

function postersProject(t: MockT): MockProject {
  const paris = t("projects.posters.paris");
  const newYork = t("projects.posters.newYork");
  return {
    id: "posters",
    switcherLabel: t("projects.posters.switcherLabel"),
    name: t("projects.posters.name"),
    aspect: "9:16",
    panel: {
      tab: "image",
      prompt: t("projects.posters.prompt"),
      results: [
        { src: `${ASSETS}/poster-paris.jpg`, label: paris, selected: true },
        { src: `${ASSETS}/poster-newyork.jpg`, label: newYork },
      ],
    },
    videoSrc: `${ASSETS}/travel-loop.mp4`,
    videoPoster: `${ASSETS}/poster-paris.jpg`,
    previewCaption: t("projects.posters.captionParis"),
    timelineSeconds: 8,
    lanes: [
      [
        { label: t("projects.posters.captionParis"), at: 0.4, seconds: 3.2, tone: "text" },
        { label: t("projects.posters.captionNewYork"), at: 4.4, seconds: 3.2, tone: "text" },
      ],
    ],
    clips: [
      { label: t("projects.posters.clipParis"), thumb: `${ASSETS}/poster-paris.jpg`, at: 0, seconds: 4, selected: true },
      { label: t("projects.posters.clipNewYork"), thumb: `${ASSETS}/poster-newyork.jpg`, at: 4, seconds: 4 },
    ],
    audio: [[{ label: "Parisian waltz.mp3", at: 0, seconds: 8 }]],
    chat: [
      { role: "user", text: t("projects.posters.chat1") },
      {
        role: "assistant",
        text: t("projects.posters.chat2"),
        cards: [
          { src: `${ASSETS}/poster-paris.jpg`, label: paris },
          { src: `${ASSETS}/poster-newyork.jpg`, label: newYork },
        ],
      },
      { role: "user", text: t("projects.posters.chat3") },
      { role: "assistant", text: t("projects.posters.chat4") },
    ],
  };
}

function railwayProject(t: MockT): MockProject {
  const canyonRun = t("projects.railway.canyonRun");
  const onTheRoof = t("projects.railway.onTheRoof");
  const bicycleChase = t("projects.railway.bicycleChase");
  return {
    id: "railway",
    switcherLabel: t("projects.railway.switcherLabel"),
    name: t("projects.railway.name"),
    aspect: "16:9",
    panel: {
      tab: "video",
      prompt: t("projects.railway.prompt"),
      results: [
        { src: `${ASSETS}/chase-1.jpg`, label: canyonRun, duration: "3.2s", selected: true },
        { src: `${ASSETS}/chase-2.jpg`, label: onTheRoof, duration: "2.8s" },
        { src: `${ASSETS}/chase-3.jpg`, label: bicycleChase, duration: "4.0s" },
      ],
    },
    videoSrc: `${ASSETS}/railway-loop.mp4`,
    videoPoster: `${ASSETS}/chase-1.jpg`,
    previewCaption: "",
    timelineSeconds: 10,
    lanes: [],
    clips: [
      { label: canyonRun, thumb: `${ASSETS}/chase-1.jpg`, at: 0, seconds: 3.2 },
      { label: onTheRoof, thumb: `${ASSETS}/chase-2.jpg`, at: 3.2, seconds: 2.8, selected: true },
      { label: bicycleChase, thumb: `${ASSETS}/chase-3.jpg`, at: 6, seconds: 4 },
    ],
    audio: [
      [{ label: "Steam & Strings.mp3", at: 0, seconds: 10 }],
      [
        { label: t("projects.railway.trainWhistle"), at: 0.6, seconds: 1.4 },
        { label: t("projects.railway.wheelsOnGravel"), at: 6.4, seconds: 2.2 },
      ],
    ],
    chat: [
      { role: "user", text: t("projects.railway.chat1") },
      { role: "assistant", text: t("projects.railway.chat2") },
      { role: "user", text: t("projects.railway.chat3") },
      {
        role: "assistant",
        text: t("projects.railway.chat4"),
        cards: [
          { src: `${ASSETS}/chase-1.jpg`, label: t("projects.railway.shot", { number: 1 }), duration: "3.2s" },
          { src: `${ASSETS}/chase-2.jpg`, label: t("projects.railway.shot", { number: 2 }), duration: "2.8s" },
          { src: `${ASSETS}/chase-3.jpg`, label: t("projects.railway.shot", { number: 3 }), duration: "4.0s" },
        ],
      },
      { role: "user", text: t("projects.railway.chat5") },
      { role: "assistant", text: t("projects.railway.chat6") },
    ],
  };
}

// The mock the onboarding sequence shows: the starter project every new
// account opens on (public/cut-starter), laid out the way it first opens —
// side panel folded to its rail, chat beside the cut. Bar labels are the
// project's own names and on-screen text, so they stay as made in every
// language.
const RECAP_SECONDS = 35.6;

// Main track: [start, length, muted] per clip, in timeline order, matching the
// frames of recap-clips.jpg.
const RECAP_CUTS: [number, number, boolean][] = [
  [9, 2.75, false], [11.75, 0.67, true], [12.42, 0.5, true], [12.92, 0.52, true], [13.43, 0.52, true], [13.95, 0.55, true],
  [14.5, 0.52, true], [15.02, 0.4, true], [15.42, 0.57, true], [15.98, 0.5, true], [16.48, 0.53, true], [17.02, 0.67, true],
  [17.68, 0.57, true], [18.25, 0.5, true], [18.75, 0.67, true], [19.42, 0.6, true], [20.02, 0.5, true], [20.52, 0.5, true],
  [21.02, 0.5, true], [21.52, 0.57, true], [22.08, 0.5, true], [22.58, 0.5, true], [23.08, 0.57, true], [23.65, 0.73, true],
  [24.38, 0.37, true], [24.75, 0.53, true], [25.28, 0.6, true], [25.88, 0.5, true], [26.38, 0.63, true], [27.02, 0.5, true],
  [27.52, 0.57, true], [28.08, 0.6, true], [28.68, 0.57, true], [29.25, 0.63, true], [29.88, 0.4, true], [30.28, 0.53, true],
  [30.82, 0.57, true], [31.38, 0.53, true], [31.92, 0.53, true], [32.45, 0.57, true], [33.02, 0.57, true], [33.58, 0.53, true],
  [34.12, 0.63, true], [34.75, 0.7, true],
];

// The intro pieces' shared keyframe spacing: the D's three parts scale up
// together, then their streaks burst.
const D_KEYS = [0, 0.22, 0.37, 0.49, 0.62, 0.74, 0.86, 0.9, 0.99, 1];
const STREAK_KEYS = [0, 0.28, 0.47, 0.57, 0.75, 0.85, 0.94, 1];
const PROFILE_KEYS = [0, 0.12, 0.88, 1];

export function onboardingProject(t: MockT): MockProject {
  const lightBars = t("projects.recap.lightBars");
  const flash = t("projects.recap.flash");
  const sticker = t("projects.recap.sticker");
  return {
    id: "recap",
    switcherLabel: t("projects.recap.switcherLabel"),
    name: "August Recap",
    aspect: "16:9",
    panel: null,
    videoSrc: `${ASSETS}/recap-loop.mp4`,
    videoPoster: `${ASSETS}/recap-poster.jpg`,
    previewCaption: "",
    timelineSeconds: RECAP_SECONDS,
    lanes: [
      [
        { label: lightBars, at: 2, seconds: 1.65, tone: "effect" },
        { label: flash, at: 9.05, seconds: 0.35, tone: "effect" },
        { label: flash, at: 11.52, seconds: 0.2, tone: "effect" },
        { label: flash, at: 11.75, seconds: 0.15, tone: "effect" },
        { label: flash, at: 35, seconds: 0.45, tone: "effect" },
      ],
      [
        { label: "D bowl top", at: 0, seconds: 1.62, tone: "element", keys: D_KEYS },
        { label: "Mouse cursor", at: 4.8, seconds: 1.6, tone: "element", keys: [0, 0.25, 0.71, 0.77, 0.84, 1] },
        { label: "Loading spinner", at: 7.6, seconds: 1.4, tone: "element", keys: [0, 0.11, 0.75, 1] },
        { label: "Progress knob", at: 11.75, seconds: 23.7, tone: "element", keys: [0, 1] },
      ],
      [
        { label: "D bowl top streaks", at: 1.45, seconds: 0.53, tone: "element", keys: STREAK_KEYS },
        { label: "Who's watching?", at: 4.07, seconds: 2.43, tone: "text", keys: PROFILE_KEYS },
        { label: "Mouse cursor (title page)", at: 10.2, seconds: 1.55, tone: "element", keys: [0, 0.31] },
        { label: "Progress fill", at: 11.75, seconds: 23.7, tone: "element", keys: [0, 1] },
      ],
      [
        { label: "D bowl bottom", at: 0, seconds: 1.62, tone: "element", keys: D_KEYS },
        { label: sticker, at: 4.07, seconds: 4.93, tone: "element", keys: [0, 0.06, 0.49, 0.63, 0.72, 0.93, 1] },
        { label: "Play", at: 9, seconds: 2.75, tone: "text" },
        { label: "Progress track", at: 11.75, seconds: 23.7, tone: "element" },
      ],
      [
        { label: "D bowl bottom streaks", at: 1.45, seconds: 0.53, tone: "element", keys: STREAK_KEYS },
        { label: sticker, at: 4.07, seconds: 2.43, tone: "element", keys: PROFILE_KEYS },
        { label: "Play icon", at: 9, seconds: 2.75, tone: "element" },
        { label: "S1 EPISODE: AUGUST Recap", at: 11.75, seconds: 23.7, tone: "text" },
      ],
    ],
    clips: RECAP_CUTS.map(([at, seconds, muted], frame) => ({
      label: t("projects.recap.shot", { number: frame + 1 }),
      at,
      seconds,
      frame,
      muted,
    })),
    clipStrip: { src: `${ASSETS}/recap-clips.jpg`, count: RECAP_CUTS.length },
    audio: [
      [
        { label: "august-recap-opener", at: 0, seconds: 3.8 },
        { label: "Clicks Mouse", at: 5.93, seconds: 0.1 },
        { label: "Clicks Mouse", at: 6.04, seconds: 0.1 },
        { label: "Whoosh Slide", at: 6.31, seconds: 1.49 },
        { label: "august-recap-music", at: 9, seconds: 26.6 },
      ],
    ],
    chat: [
      { role: "user", text: t("projects.recap.chat1") },
      { role: "assistant", toolCalls: 14, text: t("projects.recap.chat2") },
      { role: "user", text: t("projects.recap.chat3") },
    ],
  };
}
