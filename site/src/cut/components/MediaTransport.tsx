"use client";

import { useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatElapsed } from "@/cut/lib/time";

/**
 * The transport every in-app player wears: play/pause, a draggable scrub bar,
 * the clock, and an optional mute toggle. Media elements in the editor render
 * with `controls` off and this bar on top, so playback carries the app's own
 * chrome wherever it appears.
 *
 * `overlay` floats it over the picture on a scrim — the parent carries
 * `group` and `relative`, and the bar shows on hover, on focus, while a scrub
 * is in flight, and whenever the player is paused. `inline` draws a plain row
 * wherever it is placed.
 */
export function MediaTransport({
  playing,
  time,
  duration,
  muted,
  variant = "overlay",
  className,
  onToggle,
  onSeek,
  onToggleMute,
}: {
  playing: boolean;
  time: number;
  duration: number;
  /** Pass alongside `onToggleMute` to draw the volume button. */
  muted?: boolean;
  variant?: "overlay" | "inline";
  className?: string;
  onToggle: () => void;
  onSeek: (t: number) => void;
  onToggleMute?: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const pct = duration > 0 ? Math.min(1, Math.max(0, time / duration)) * 100 : 0;

  const seekFrom = (clientX: number) => {
    const el = barRef.current;
    if (!el || duration <= 0) return;
    const r = el.getBoundingClientRect();
    onSeek(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration);
  };

  return (
    <div
      className={cn(
        "z-20 flex items-center gap-3",
        variant === "overlay"
          ? [
              "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/45 to-transparent px-4 pt-10 pb-3.5",
              "opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100",
              (scrubbing || !playing) && "opacity-100",
            ]
          : "px-0.5",
        className
      )}
    >
      <button
        type="button"
        className="grid size-8 shrink-0 place-items-center rounded-full bg-white/15 text-white backdrop-blur-sm transition-colors hover:bg-white/25"
        aria-label={playing ? "Pause" : "Play"}
        title={playing ? "Pause" : "Play"}
        onClick={onToggle}
      >
        {playing ? <Pause className="size-4 fill-white" /> : <Play className="size-4 fill-white" />}
      </button>

      <div
        ref={barRef}
        className="relative h-4 flex-1 cursor-pointer touch-none"
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, duration)}
        aria-valuenow={time}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setScrubbing(true);
          seekFrom(e.clientX);
        }}
        onPointerMove={(e) => scrubbing && seekFrom(e.clientX)}
        onPointerUp={() => setScrubbing(false)}
        onPointerCancel={() => setScrubbing(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") onSeek(Math.max(0, time - 1));
          else if (e.key === "ArrowRight") onSeek(Math.min(duration, time + 1));
          else return;
          e.preventDefault();
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/30">
          <div className="h-full rounded-full bg-white" style={{ width: `${pct}%` }} />
        </div>
        <span
          className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.5)]"
          style={{ left: `${pct}%` }}
        />
      </div>

      <span className="shrink-0 text-[11px] font-medium text-white/90 tabular-nums">
        {formatElapsed(time * 1000)} / {formatElapsed(duration * 1000)}
      </span>

      {onToggleMute && (
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white"
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Unmute" : "Mute"}
          onClick={onToggleMute}
        >
          {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
        </button>
      )}
    </div>
  );
}
