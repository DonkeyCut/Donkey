// Everything the landing's static editor replica shows, hardcoded per slide.
// The mock components render exactly this — no stores, no engine. The words
// come from the `mock` catalog, so the fake project reads in the page's
// language; file names and the voiceover's own speech stay as recorded.
import type { useTranslations } from "next-intl";

/** The `mock` catalog's translator, as the factories below take it. */
export type MockT = ReturnType<typeof useTranslations<"mock">>;


export type MockAspect = "9:16" | "16:9";

export type MockPanelTab =
  | "media"
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

/** One card in the Media panel's grid — a file the user brought into the
 * project, with the short handle (`v1`, `a1`) prompts can reference it by. */
export interface MockMediaItem {
  kind: "video" | "image" | "audio";
  handle: string;
  name: string;
  /** Poster for video and image cards; audio draws a waveform face instead. */
  thumb?: string;
  duration?: string;
}

/** A saved arrangement in the Media panel, collapsed to its summary row. */
export interface MockTemplate {
  name: string;
  duration: string;
  items: number;
}

/** Which panel is open on the left, and what it holds. The Media panel lists
 * the project's own files; the generate panels are a prompt over its results. */
export type MockPanel =
  | { tab: "media"; templates: MockTemplate[]; items: MockMediaItem[] }
  | { tab: "image" | "video"; prompt: string; results: MockResultCard[] };

export interface MockChatMessage {
  role: "user" | "assistant";
  text: string;
  /** Tool-call chip above the message, as the assistant's turn shows its work. */
  tool?: { name: string; count?: number };
  /** Result cards rendered under the message text. */
  cards?: MockResultCard[];
  /** Cards are 9:16 rather than the default 3:4 / 16:9. */
  portrait?: boolean;
}

export interface MockClip {
  label: string;
  thumb: string;
  seconds: number;
  selected?: boolean;
  muted?: boolean;
}

export interface MockCue {
  text: string;
  /** Start position in timeline seconds. */
  at: number;
  seconds: number;
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
  clips: MockClip[];
  captions: MockCue[];
  audioLabel: string;
  audioDuration: string;
  sfx: MockCue[];
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
    clips: [
      { label: t("projects.posters.clipParis"), thumb: `${ASSETS}/poster-paris.jpg`, seconds: 4, selected: true },
      { label: t("projects.posters.clipNewYork"), thumb: `${ASSETS}/poster-newyork.jpg`, seconds: 4 },
    ],
    captions: [
      { text: t("projects.posters.captionParis"), at: 0.4, seconds: 3.2 },
      { text: t("projects.posters.captionNewYork"), at: 4.4, seconds: 3.2 },
    ],
    audioLabel: "Parisian waltz.mp3",
    audioDuration: "8.0s",
    sfx: [],
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
    clips: [
      { label: canyonRun, thumb: `${ASSETS}/chase-1.jpg`, seconds: 3.2 },
      { label: onTheRoof, thumb: `${ASSETS}/chase-2.jpg`, seconds: 2.8, selected: true },
      { label: bicycleChase, thumb: `${ASSETS}/chase-3.jpg`, seconds: 4 },
    ],
    captions: [],
    audioLabel: "Steam & Strings.mp3",
    audioDuration: "10.0s",
    sfx: [
      { text: t("projects.railway.trainWhistle"), at: 0.6, seconds: 1.4 },
      { text: t("projects.railway.wheelsOnGravel"), at: 6.4, seconds: 2.2 },
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

// The mock the onboarding sequence shows: a real project a parent built from
// one voiceover of their son introducing himself, so the slide's subject — the
// assistant working the timeline mid-conversation — is what the frame shows.
// The voiceover's speech is the recording's own Korean in every language.
const VOICEOVER_SPEECH = "안녕 내 이름은 메이슨이고 한국에 사는 꼬마 소년이야 나는 학교에 가는 걸 좋아해";

export function onboardingProject(t: MockT): MockProject {
  const voiceover = t("projects.mason.voiceover", { text: VOICEOVER_SPEECH });
  const scenePrompt = t("projects.mason.scenePrompt");
  const template = t("projects.mason.template");
  return {
    id: "mason",
    switcherLabel: t("projects.mason.switcherLabel"),
    name: t("projects.mason.name"),
    aspect: "9:16",
    panel: {
      tab: "media",
      templates: [
        { name: template, duration: "0:03.9", items: 2 },
        { name: template, duration: "0:05.3", items: 2 },
      ],
      items: [
        { kind: "audio", handle: "a1", name: voiceover, duration: "0:16.2" },
        { kind: "video", handle: "v1", name: scenePrompt, thumb: `${ASSETS}/mason-school.jpg`, duration: "0:10.0" },
        { kind: "video", handle: "v2", name: scenePrompt, thumb: `${ASSETS}/mason-fish.jpg`, duration: "0:10.0" },
        { kind: "image", handle: "i1", name: "Screenshot 2026-07-19 at 9.57.03 PM.png", thumb: `${ASSETS}/mason-shot.jpg` },
        { kind: "video", handle: "v3", name: scenePrompt, thumb: `${ASSETS}/mason-school.jpg`, duration: "0:10.0" },
        { kind: "video", handle: "v4", name: scenePrompt, thumb: `${ASSETS}/mason-fish.jpg`, duration: "0:10.0" },
        { kind: "video", handle: "v5", name: scenePrompt, thumb: `${ASSETS}/mason-school.jpg`, duration: "0:10.0" },
        { kind: "video", handle: "v6", name: scenePrompt, thumb: `${ASSETS}/mason-fish.jpg`, duration: "0:10.0" },
      ],
    },
    videoSrc: `${ASSETS}/mason-loop.mp4`,
    videoPoster: `${ASSETS}/mason-walk.jpg`,
    previewCaption: "",
    timelineSeconds: 16.28,
    clips: [
      { label: t("projects.mason.walkingToSchool"), thumb: `${ASSETS}/mason-walk.jpg`, seconds: 4.8, muted: true },
      { label: t("projects.mason.schoolGates"), thumb: `${ASSETS}/mason-school.jpg`, seconds: 3.2, muted: true },
      { label: t("projects.mason.fishTank"), thumb: `${ASSETS}/mason-fish.jpg`, seconds: 2.2, muted: true },
      { label: t("projects.mason.strawberries"), thumb: `${ASSETS}/mason-strawberry.jpg`, seconds: 2, muted: true },
      { label: t("projects.mason.soccer"), thumb: `${ASSETS}/mason-soccer.jpg`, seconds: 1.3, muted: true },
      { label: t("projects.mason.taekwondo"), thumb: `${ASSETS}/mason-taekwondo.jpg`, seconds: 1.3, muted: true },
      { label: t("projects.mason.swimming"), thumb: `${ASSETS}/mason-swim.jpg`, seconds: 1.48, muted: true },
    ],
    captions: [],
    audioLabel: voiceover,
    audioDuration: "16.3s",
    sfx: [],
    chat: [
      { role: "user", text: t("projects.mason.chat1") },
      {
        role: "assistant",
        tool: { name: "generate_video", count: 3 },
        text: t("projects.mason.chat2"),
        portrait: true,
        cards: [
          { src: `${ASSETS}/mason-soccer.jpg` },
          { src: `${ASSETS}/mason-taekwondo.jpg` },
          { src: `${ASSETS}/mason-swim.jpg` },
        ],
      },
      { role: "user", text: t("projects.mason.chat3") },
    ],
  };
}
