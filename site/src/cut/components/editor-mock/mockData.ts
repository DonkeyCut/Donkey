// Everything the landing's static editor replica shows, hardcoded per slide.
// The mock components render exactly this — no stores, no engine.

export type MockAspect = "9:16" | "16:9";

export type MockPanelTab =
  | "media"
  | "library"
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

export const MOCK_PROJECTS: MockProject[] = [
  {
    id: "posters",
    switcherLabel: "Travel posters",
    name: "City poster series",
    aspect: "9:16",
    panel: {
      tab: "image",
      prompt:
        "Hand-painted travel poster, PARIS — woman in a trench coat crossing the street, Eiffel Tower behind, café awnings, 'Live the romance' in red script",
      results: [
        { src: `${ASSETS}/poster-paris.jpg`, label: "Paris", selected: true },
        { src: `${ASSETS}/poster-newyork.jpg`, label: "New York" },
      ],
    },
    videoSrc: `${ASSETS}/travel-loop.mp4`,
    videoPoster: `${ASSETS}/poster-paris.jpg`,
    previewCaption: "Live the romance",
    timelineSeconds: 8,
    clips: [
      { label: "Paris — Live the romance", thumb: `${ASSETS}/poster-paris.jpg`, seconds: 4, selected: true },
      { label: "New York — Rise above the city", thumb: `${ASSETS}/poster-newyork.jpg`, seconds: 4 },
    ],
    captions: [
      { text: "Live the romance", at: 0.4, seconds: 3.2 },
      { text: "Rise above the city", at: 4.4, seconds: 3.2 },
    ],
    audioLabel: "Parisian waltz.mp3",
    audioDuration: "8.0s",
    sfx: [],
    chat: [
      {
        role: "user",
        text: "Make two hand-painted travel posters — Paris and New York, same woman crossing the street in both.",
      },
      {
        role: "assistant",
        text: "Here are the two posters, matched palette and typography:",
        cards: [
          { src: `${ASSETS}/poster-paris.jpg`, label: "Paris" },
          { src: `${ASSETS}/poster-newyork.jpg`, label: "New York" },
        ],
      },
      {
        role: "user",
        text: "Animate them — she walks, slow camera drift, keep the painted texture. Then cut them together with captions and music.",
      },
      {
        role: "assistant",
        text: "Rendered two 4s clips and assembled the timeline with captions and a waltz. Want a different track?",
      },
    ],
  },
  {
    id: "railway",
    switcherLabel: "Railway mystery",
    name: "The Railway Mystery",
    aspect: "16:9",
    panel: {
      tab: "video",
      prompt:
        "Franco-Belgian comic style, early-1900s animation with film grain: a steam train races a cliffside railway through a mountain canyon; a cloaked figure rides the carriage roof; a boy on a bicycle gives chase",
      results: [
        { src: `${ASSETS}/chase-1.jpg`, label: "Canyon run", duration: "3.2s", selected: true },
        { src: `${ASSETS}/chase-2.jpg`, label: "On the roof", duration: "2.8s" },
        { src: `${ASSETS}/chase-3.jpg`, label: "Bicycle chase", duration: "4.0s" },
      ],
    },
    videoSrc: `${ASSETS}/railway-loop.mp4`,
    videoPoster: `${ASSETS}/chase-1.jpg`,
    previewCaption: "",
    timelineSeconds: 10,
    clips: [
      { label: "Canyon run", thumb: `${ASSETS}/chase-1.jpg`, seconds: 3.2 },
      { label: "On the roof", thumb: `${ASSETS}/chase-2.jpg`, seconds: 2.8, selected: true },
      { label: "Bicycle chase", thumb: `${ASSETS}/chase-3.jpg`, seconds: 4 },
    ],
    captions: [],
    audioLabel: "Steam & Strings.mp3",
    audioDuration: "10.0s",
    sfx: [
      { text: "train whistle", at: 0.6, seconds: 1.4 },
      { text: "wheels on gravel", at: 6.4, seconds: 2.2 },
    ],
    chat: [
      {
        role: "user",
        text: "Storyboard a 1920s comic-style chase: a mysterious figure on a steam train, a kid chasing on a bicycle through a canyon.",
      },
      {
        role: "assistant",
        text: "Three shots: 1) the train threading the canyon, 2) the cloaked figure steadying himself on the roof, 3) the boy pedaling hard beside the tracks.",
      },
      { role: "user", text: "Animate all three in that ligne-claire style." },
      {
        role: "assistant",
        text: "Rendered the three shots and cut them with a brass-and-strings score:",
        cards: [
          { src: `${ASSETS}/chase-1.jpg`, label: "Shot 1", duration: "3.2s" },
          { src: `${ASSETS}/chase-2.jpg`, label: "Shot 2", duration: "2.8s" },
          { src: `${ASSETS}/chase-3.jpg`, label: "Shot 3", duration: "4.0s" },
        ],
      },
      {
        role: "user",
        text: "Add a train whistle when it clears the tunnel, and gravel under the bicycle.",
      },
      {
        role: "assistant",
        text: "Placed both on the effects track and mixed them under the score. Want the cut tightened where the train enters the tunnel?",
      },
    ],
  },
];
