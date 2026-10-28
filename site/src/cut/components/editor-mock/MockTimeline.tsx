"use client";

// Static replica of the Cut editor timeline for the landing page. Pure
// presentation: geometry and chrome copied from src/cut/components/Timeline.tsx.

import type { CSSProperties } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronDown,
  Eye,
  Grid3x3,
  Magnet,
  PanelBottomClose,
  Play,
  Scissors,
  SkipBack,
  Type,
  Volume2,
  VolumeX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { MockBar, MockClip, MockLaneTone, MockProject } from "@/cut/components/editor-mock/mockData";

// The timeline spans the editor column left of the full-height chat panel
// (1200 − 340). A gutter of row toggles sits left of the tracks.
const COLUMN_W = 860;
const GUTTER_W = 22;
const TRACK_W = COLUMN_W - GUTTER_W - 14;
const TOOLBAR_H = 36;
const RULER_H = 24;
const LANE_H = 22;
const VIDEO_H = 44;
const AUDIO_H = 28;
const BAR_GAP = 1;

/** Ruler steps, smallest first; the first that leaves room for a label wins. */
const TICK_STEPS = [0.5, 1, 2, 5, 10];
const MIN_TICK_PX = 80;

/** Element bar colors by family, as Timeline.tsx paints them. */
const TONE_BAR: Record<MockLaneTone, string> = {
  text: "bg-[#7B4BD1]",
  element: "bg-[#C43C87]",
  effect: "bg-[#0D8577]",
};

/** Deterministic waveform silhouette, tiled across audio bars. */
const WAVE = [
  38, 62, 45, 80, 55, 92, 40, 68, 74, 50, 88, 34, 58, 76, 44, 95, 60, 30, 70,
  52, 84, 46, 66, 90, 36, 72, 56, 82, 42, 64,
];

/** The ruler's clock: minutes, then seconds to a tenth ("0:02.0"). */
const clock = (s: number) =>
  `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** The transport's clock: hundredths, as the editor shows it ("0:35.59"). */
const transportClock = (s: number) =>
  `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;

export function MockTimeline({ project }: { project: MockProject }) {
  const t = useTranslations("mock.timeline");
  const pxPerSec = TRACK_W / project.timelineSeconds;
  const step = TICK_STEPS.find((s) => s * pxPerSec >= MIN_TICK_PX) ?? TICK_STEPS.at(-1)!;
  const ticks = Array.from(
    { length: Math.floor(project.timelineSeconds / step) + 1 },
    (_, i) => i * step,
  );
  const rowsH =
    project.lanes.length * LANE_H + VIDEO_H + project.audio.length * AUDIO_H;
  const place = (at: number, seconds: number) => ({
    left: at * pxPerSec,
    width: Math.max(2, seconds * pxPerSec - BAR_GAP),
  });

  return (
    <div className="relative shrink-0 overflow-hidden border-t border-border bg-card select-none">
      {/* Toolbar: timeline picker and edit tools, the transport, then view
          controls. */}
      <div
        className="grid grid-cols-[1fr_auto_1fr] items-center px-3 text-muted-foreground"
        style={{ height: TOOLBAR_H }}
      >
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1 text-[11.5px] font-medium text-foreground">
            {t("main")} <ChevronDown className="size-3" />
          </span>
          <span className="h-4 w-px bg-border" />
          <Type className="size-3.5" />
          <span className="h-4 w-px bg-border" />
          <Magnet className="size-3.5" />
          <Scissors className="size-3.5" />
        </div>
        <div className="flex items-center gap-2.5">
          <SkipBack className="size-3.5" />
          <span className="grid size-6 place-items-center rounded-full bg-foreground text-background">
            <Play className="size-3 translate-x-px fill-current" />
          </span>
          <span className="font-mono text-[11px] tabular-nums text-foreground">
            {transportClock(0)}{" "}
            <span className="text-muted-foreground">/ {transportClock(project.timelineSeconds)}</span>
          </span>
        </div>
        <div className="flex items-center justify-end gap-2.5">
          <span className="flex items-center gap-0.5">
            <Grid3x3 className="size-3.5" /> <ChevronDown className="size-2.5" />
          </span>
          <span className="relative h-[3px] w-16 rounded-full bg-foreground/20">
            <span className="absolute top-1/2 left-[35%] size-2.5 -translate-y-1/2 rounded-full bg-foreground" />
          </span>
          <span className="text-[11px] font-medium text-foreground">{t("fit")}</span>
          <PanelBottomClose className="size-3.5" />
        </div>
      </div>

      {/* Ruler */}
      <div className="relative border-y border-border" style={{ height: RULER_H }}>
        {ticks.map((s) => (
          <div
            key={s}
            className="absolute top-0 bottom-0 border-l border-foreground/15 pl-1.5"
            style={{ left: GUTTER_W + s * pxPerSec }}
          >
            <span className="font-mono text-[9.5px] leading-[22px] tabular-nums text-muted-foreground">
              {clock(s)}
            </span>
          </div>
        ))}
      </div>

      <div className="relative" style={{ height: rowsH + 6 }}>
        {/* Element rows, top row first */}
        {project.lanes.map((lane, i) => (
          <Row key={i} height={LANE_H} icon="eye">
            {lane.map((bar, j) => (
              <LaneBar key={j} bar={bar} style={place(bar.at, bar.seconds)} />
            ))}
          </Row>
        ))}

        {/* Video track */}
        <Row height={VIDEO_H} icon="eye">
          {project.clips.map((clip, i) => (
            <ClipTile key={i} clip={clip} strip={project.clipStrip} style={place(clip.at, clip.seconds)} />
          ))}
        </Row>

        {/* Audio rows */}
        {project.audio.map((row, i) => (
          <Row key={i} height={AUDIO_H} icon="volume">
            {row.map((bar, j) => (
              <AudioBar key={j} bar={bar} seed={i * 7 + j} style={place(bar.at, bar.seconds)} />
            ))}
          </Row>
        ))}

        {/* Playhead: the editor's own (Timeline.tsx) — same blue, glow, and
            cap — swept externally via the mock-playhead keyframes. */}
        <div
          className="mock-playhead pointer-events-none absolute top-0 z-30 w-[1.5px] bg-[#0a84ff] shadow-[0_0_8px_rgba(10,132,255,0.6)]"
          style={{
            left: GUTTER_W,
            height: rowsH,
            "--track-w": TRACK_W + "px",
            "--sweep-s": project.timelineSeconds + "s",
          } as CSSProperties}
        >
          <div className="absolute -top-0 -left-[7px] h-5 w-4">
            <div className="mx-auto h-3 w-2.5 rounded-t-[3px] bg-[#0a84ff] [clip-path:polygon(0_0,100%_0,100%_58%,50%_100%,0_58%)]" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** One track row: its toggle in the gutter, then bars placed by time. */
function Row({
  height,
  icon,
  children,
}: {
  height: number;
  icon: "eye" | "volume";
  children: React.ReactNode;
}) {
  const Icon = icon === "eye" ? Eye : Volume2;
  return (
    <div className="relative flex border-b border-border" style={{ height }}>
      <span className="grid shrink-0 place-items-center text-muted-foreground/70" style={{ width: GUTTER_W }}>
        <Icon className="size-3" />
      </span>
      <div className="relative min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A text, element, or effect bar, with its keyframe diamonds. */
function LaneBar({ bar, style }: { bar: MockBar; style: CSSProperties }) {
  return (
    <div
      className={cn(
        "absolute top-[2px] bottom-[2px] overflow-hidden rounded-[3px]",
        TONE_BAR[bar.tone ?? "element"],
      )}
      style={style}
    >
      <span className="absolute inset-y-0 left-1.5 flex items-center truncate text-[10px] font-medium whitespace-nowrap text-white">
        {bar.label}
      </span>
      {bar.keys?.map((k, i) => (
        <span
          key={i}
          className="absolute top-1/2 size-[6px] -translate-x-1/2 -translate-y-1/2 rotate-45 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
          style={{ left: `${Math.min(96, Math.max(4, k * 100))}%` }}
        />
      ))}
    </div>
  );
}

/** A video clip: its frame, and the muted badge when its sound is off. */
function ClipTile({
  clip,
  strip,
  style,
}: {
  clip: MockClip;
  strip: MockProject["clipStrip"];
  style: CSSProperties;
}) {
  const tileW = ((VIDEO_H - 4) * 16) / 9;
  // A strip frame shows at the tile's native aspect from the clip's left edge;
  // a poster tiles across the whole clip.
  const face: CSSProperties =
    strip && clip.frame !== undefined
      ? {
          width: tileW,
          backgroundImage: `url(${strip.src})`,
          backgroundSize: `${strip.count * 100}% 100%`,
          backgroundPosition: `${(clip.frame / Math.max(1, strip.count - 1)) * 100}% 0`,
        }
      : {
          right: 0,
          backgroundImage: `url(${clip.thumb})`,
          backgroundSize: "auto 100%",
          backgroundRepeat: "repeat-x",
        };
  return (
    <div
      role="img"
      aria-label={clip.label}
      className={cn(
        "absolute top-[2px] bottom-[2px] overflow-hidden rounded-[3px] bg-black shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]",
        clip.selected && "z-10 ring-2 ring-[#0a84ff]",
      )}
      style={style}
    >
      <div className="absolute inset-y-0 left-0" style={face} />
      {clip.muted && Number(style.width) >= 14 && (
        <span className="absolute bottom-0.5 left-0.5 grid size-[13px] place-items-center rounded-[3px] bg-black/65 text-white">
          <VolumeX className="size-2" />
        </span>
      )}
    </div>
  );
}

/** A sound bar: waveform under its file name. */
function AudioBar({ bar, seed, style }: { bar: MockBar; seed: number; style: CSSProperties }) {
  const width = Number(style.width);
  return (
    <div
      className="absolute top-[2px] bottom-[2px] overflow-hidden rounded-[3px] bg-gradient-to-b from-[#1fae84] to-[#16956f]"
      style={style}
    >
      <div className="absolute inset-x-1 bottom-0.5 flex h-[55%] items-end justify-between">
        {Array.from({ length: Math.max(1, Math.floor(width / 4)) }, (_, i) => (
          <span
            key={i}
            className="w-[1.5px] rounded-full bg-white/80"
            style={{ height: `${WAVE[(i + seed) % WAVE.length]}%` }}
          />
        ))}
      </div>
      <span className="absolute top-px left-1.5 text-[9px] whitespace-nowrap text-white/90 [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]">
        {bar.label}
      </span>
    </div>
  );
}
