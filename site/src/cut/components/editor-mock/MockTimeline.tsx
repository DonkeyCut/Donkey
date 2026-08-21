"use client";

// Static replica of the Cut editor timeline for the landing page. Pure
// presentation: geometry and chrome copied from src/cut/components/Timeline.tsx.

import type { CSSProperties } from "react";
import { VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MockProject } from "@/cut/components/editor-mock/mockData";

// The timeline column sits left of the full-height chat panel (340px), so its
// usable track width is the frame minus that column and some gutter.
const TRACK_W = 800;
const CLIP_GAP = 4;
const PANEL_H = 190;
const RULER_H = 26;
const VIDEO_H = 76;
const WAVE_H = 20;
const AUDIO_H = 40;
const SUB_H = 18;
const SFX_H = 20;

/** Deterministic waveform silhouette, tiled across the audio bar. */
const WAVE = [
  38, 62, 45, 80, 55, 92, 40, 68, 74, 50, 88, 34, 58, 76, 44, 95, 60, 30, 70,
  52, 84, 46, 66, 90, 36, 72, 56, 82, 42, 64,
];

export function MockTimeline({ project }: { project: MockProject }) {
  const pxPerSec = TRACK_W / project.timelineSeconds;
  const ticks = Array.from({ length: Math.ceil(project.timelineSeconds) }, (_, i) => i);

  // Clips butt up against each other; each starts where the previous ended.
  const clips = project.clips.map((c, i) => ({
    ...c,
    left:
      project.clips.slice(0, i).reduce((sec, prev) => sec + prev.seconds, 0) *
      pxPerSec,
    width: Math.max(10, c.seconds * pxPerSec - CLIP_GAP),
  }));

  return (
    <div className="relative shrink-0 overflow-hidden border-t border-border bg-muted select-none" style={{ height: PANEL_H }}>
      {/* Ruler strip runs edge to edge like the editor's card-backed ruler. */}
      <div className="absolute inset-x-0 top-0 border-b border-border bg-card" style={{ height: RULER_H }} />

      <div className="relative mx-auto" style={{ width: TRACK_W }}>
        {/* Time ruler */}
        <div className="relative" style={{ height: RULER_H }}>
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute top-0 bottom-0 border-l border-foreground/15 pl-1.5"
              style={{ left: t * pxPerSec }}
            >
              <span className="font-mono text-[10px] leading-6 tabular-nums text-muted-foreground">
                {t}s
              </span>
            </div>
          ))}
        </div>

        {/* Video track */}
        <div className="relative mt-1.5" style={{ height: VIDEO_H }}>
          <div className="pointer-events-none absolute h-px bg-border" style={{ top: VIDEO_H - 2, left: -20, right: -20 }} />
          {clips.map((c) => (
            <div
              key={c.label}
              role="img"
              aria-label={c.label}
              className={cn(
                "absolute top-0.5 overflow-hidden rounded-lg bg-black shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]",
                c.selected && "z-10 ring-2 ring-[#0a84ff]"
              )}
              style={{ left: c.left, width: c.width, height: c.muted ? VIDEO_H - 4 - WAVE_H : VIDEO_H - 4 }}
            >
              <div
                className="absolute inset-x-0 top-0"
                style={{
                  height: VIDEO_H - 4 - WAVE_H,
                  // The editor draws a clip as a strip of frames repeated across
                  // its width; one tile at native aspect gives the same read.
                  backgroundImage: `url(${c.thumb})`,
                  backgroundSize: "auto 100%",
                  backgroundRepeat: "repeat-x",
                }}
              />
              {!c.muted && (
                <div
                  className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-b from-[#59c09d] to-[#43b18d] px-1"
                  style={{ height: WAVE_H }}
                >
                  {Array.from({ length: Math.max(8, Math.floor(c.width / 5)) }, (_, i) => (
                    <span
                      key={i}
                      className="w-[2px] rounded-full bg-white/85"
                      style={{ height: `${WAVE[(i + c.label.length) % WAVE.length] * 0.7}%` }}
                    />
                  ))}
                </div>
              )}
              {c.muted && (
                <span className="absolute bottom-1 left-1 grid size-[18px] place-items-center rounded-[5px] bg-black/70 text-white">
                  <VolumeX className="size-3" />
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Caption cues */}
        {project.captions.length > 0 && (
          <div className="relative mt-1.5" style={{ height: SUB_H }}>
            <div className="pointer-events-none absolute h-px bg-border" style={{ top: SUB_H - 1, left: -20, right: -20 }} />
            {project.captions.map((cue) => (
              <div
                key={cue.text}
                className="absolute top-0 flex items-center overflow-hidden rounded-[5px] bg-gradient-to-b from-amber-300 to-amber-400 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]"
                style={{
                  left: cue.at * pxPerSec,
                  width: Math.max(8, cue.seconds * pxPerSec - CLIP_GAP),
                  height: SUB_H - 2,
                }}
              >
                <span className="truncate px-1.5 text-[9.5px] font-medium text-amber-950/90">
                  {cue.text}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* SFX chips */}
        {project.sfx.length > 0 && (
          <div className="relative mt-1.5" style={{ height: SFX_H }}>
            <div className="pointer-events-none absolute h-px bg-border" style={{ top: SFX_H - 1, left: -20, right: -20 }} />
            {project.sfx.map((fx) => (
              <div
                key={fx.text}
                className="absolute top-0 flex items-center overflow-hidden rounded-[5px] bg-gradient-to-b from-amber-300 to-amber-400 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]"
                style={{
                  left: fx.at * pxPerSec,
                  width: Math.max(8, fx.seconds * pxPerSec - CLIP_GAP),
                  height: SFX_H - 2,
                }}
              >
                <span className="truncate px-1.5 text-[9.5px] font-medium whitespace-nowrap text-amber-950/90">
                  {fx.text}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Audio track */}
        <div className="relative mt-1.5" style={{ height: AUDIO_H }}>
          <div
            className="absolute top-0 overflow-hidden rounded-[7px] bg-gradient-to-b from-emerald-500 to-emerald-600 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]"
            style={{ width: TRACK_W - CLIP_GAP, height: AUDIO_H - 4 }}
          >
            <div className="absolute inset-x-2 inset-y-1 flex items-center justify-between">
              {Array.from({ length: 60 }, (_, i) => (
                <span
                  key={i}
                  className="w-[2px] rounded-full bg-white/85"
                  style={{ height: `${WAVE[i % WAVE.length]}%` }}
                />
              ))}
            </div>
            <span className="absolute top-[3px] left-2 text-[9.5px] whitespace-nowrap text-white/90 [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]">
              {project.audioLabel}
            </span>
            <span className="absolute right-1 bottom-1 rounded px-1 py-px font-mono text-[10px] tabular-nums text-white bg-black/65">
              {project.audioDuration}
            </span>
          </div>
        </div>

        {/* Playhead: the editor's own (Timeline.tsx) — same blue, glow, and
            cap — swept externally via the mock-playhead keyframes. It runs the
            full panel, past the last track into the empty space below, so the
            column of rows reads as one cut rather than stopping at the audio. */}
        <div
          className="mock-playhead pointer-events-none absolute top-0 left-0 z-30 w-[1.5px] bg-[#0a84ff] shadow-[0_0_8px_rgba(10,132,255,0.6)]"
          style={{
            height: PANEL_H - 8,
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
