"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play, Scissors } from "lucide-react";

import { Headline } from "@/app/_components/landing/LandingPrimitives";
import { CARD, type CardColor } from "@/app/_components/landing/theme";
import { cn } from "@/lib/utils";

// The editing pitch as a three-track story on one shared time axis:
//   1. Raw footage — every segment of the recording side by side.
//   2. Clipped out — ghost outlines at the exact spots the awkward moments
//      sat in the raw take.
//   3. Final cut — the kept segments packed left into the shorter finished video.
// Every track is playable: selecting one plays just its clips, so the ghost
// track shows exactly what is getting clipped out. Segments are placeholder
// tiles for now; when a segment gets a real `src`, the tile is where its
// footage renders.

type Segment = {
  label: string;
  seconds: number;
  /** Kept segments make the final cut; the rest land on the ghost track. */
  kept: boolean;
  /** Tile color while the segment is a placeholder. */
  color: CardColor;
  /** Real footage lands here later; a segment with a src renders its video. */
  src?: string;
};

const SEGMENTS: Segment[] = [
  { label: "Cold open", seconds: 4.5, kept: true, color: "blue" },
  { label: "False start", seconds: 2.5, kept: false, color: "cream" },
  { label: "The pitch", seconds: 5, kept: true, color: "yellow" },
  { label: "Dead air", seconds: 1.8, kept: false, color: "cream" },
  { label: "Demo, part one", seconds: 6, kept: true, color: "mint" },
  { label: "Retake ×3", seconds: 3.2, kept: false, color: "cream" },
  { label: "Demo, part two", seconds: 4.5, kept: true, color: "pink" },
  { label: "Phone rings", seconds: 2.2, kept: false, color: "cream" },
  { label: "Wrap-up", seconds: 4, kept: true, color: "purple" },
];

const TOTAL = SEGMENTS.reduce((sum, s) => sum + s.seconds, 0);

/** Raw-timeline start of each segment, in seconds. */
const STARTS = SEGMENTS.map((_, i) =>
  SEGMENTS.slice(0, i).reduce((sum, s) => sum + s.seconds, 0),
);

/** Final-cut start of each kept segment: prior kept seconds. */
const KEPT_STARTS = SEGMENTS.map((_, i) =>
  SEGMENTS.slice(0, i).reduce((sum, s) => sum + (s.kept ? s.seconds : 0), 0),
);

type TrackId = "raw" | "cut" | "final";

/** Which segments each track plays, in order. */
const PLAYLISTS: Record<TrackId, number[]> = {
  raw: SEGMENTS.map((_, i) => i),
  cut: SEGMENTS.flatMap((s, i) => (s.kept ? [] : [i])),
  final: SEGMENTS.flatMap((s, i) => (s.kept ? [i] : [])),
};

const TRACK_SECONDS: Record<TrackId, number> = {
  raw: TOTAL,
  cut: PLAYLISTS.cut.reduce((sum, i) => sum + SEGMENTS[i].seconds, 0),
  final: PLAYLISTS.final.reduce((sum, i) => sum + SEGMENTS[i].seconds, 0),
};

const TRACK_NAMES: Record<TrackId, string> = {
  raw: "the raw take",
  cut: "what got clipped out",
  final: "the final cut",
};

/** The sweep plays the 33.7s take in about 13s, real durations on the chips. */
const RATE = 2.6;

const pct = (seconds: number) => `${(seconds / TOTAL) * 100}%`;

function formatClock(seconds: number) {
  return `0:${String(Math.round(seconds)).padStart(2, "0")}`;
}

/** Segment under the playhead at playlist time `t`, with the offset into it. */
function playlistPos(track: TrackId, t: number) {
  let elapsed = 0;
  for (const i of PLAYLISTS[track]) {
    if (t < elapsed + SEGMENTS[i].seconds)
      return { seg: i, offset: t - elapsed };
    elapsed += SEGMENTS[i].seconds;
  }
  return null;
}

/** Seconds of kept footage the playhead has crossed by raw time `t`. */
function keptElapsed(t: number) {
  return SEGMENTS.reduce((sum, s, i) => {
    if (!s.kept) return sum;
    return sum + Math.min(Math.max(t - STARTS[i], 0), s.seconds);
  }, 0);
}

function TrackLabel({
  n,
  selected,
  seconds,
  children,
}: {
  n: string;
  selected: boolean;
  seconds: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] uppercase">
      <span
        className={cn(
          "grid size-5 place-items-center rounded-md border-2 border-ink text-[10px] transition-colors",
          selected ? "bg-coral" : "bg-white",
        )}
      >
        {n}
      </span>
      <span>{children}</span>
      <span className="font-mono text-[10px] tracking-normal text-ink/55 tabular-nums">
        {formatClock(seconds)}
      </span>
    </div>
  );
}

function Playhead({ left }: { left: string }) {
  return (
    <div
      className="pointer-events-none absolute -inset-y-1 z-10 w-[2px] rounded bg-ink"
      style={{ left }}
    >
      <div className="absolute -top-1 -left-[5px] size-3 rounded-full border-2 border-ink bg-coral" />
    </div>
  );
}

export function CutEditing() {
  const [track, setTrack] = useState<TrackId>("raw");
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  // Mirrors t so the play effect can resume from the pause point without
  // restarting on every frame.
  const tRef = useRef(0);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    if (!playing) return;
    const total = TRACK_SECONDS[track];
    const start = performance.now() - (tRef.current / RATE) * 1000;
    let raf = 0;
    const step = (now: number) => {
      const next = ((now - start) / 1000) * RATE;
      if (next >= total) {
        setT(0);
        setPlaying(false);
        return;
      }
      setT(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, track]);

  // Clicking a track plays it from the top; clicking the one already
  // selected just toggles pause, like the transport button.
  function selectTrack(id: TrackId) {
    if (id === track) {
      setPlaying((p) => !p);
      return;
    }
    setTrack(id);
    setT(0);
    setPlaying(true);
  }

  function trackKeyHandler(id: TrackId) {
    return (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectTrack(id);
      }
    };
  }

  function trackWrapperClass(id: TrackId) {
    return cn(
      "-mx-2 cursor-pointer rounded-xl border-2 p-2 transition-colors",
      track === id
        ? "border-ink/30 bg-white/55"
        : "border-transparent hover:bg-ink/5",
    );
  }

  // Everything highlights off the segment under the playhead. A paused
  // playhead keeps its spot, so highlights hold through a pause too.
  const engaged = playing || t > 0;
  const pos = engaged ? playlistPos(track, t) : null;
  const activeIndex = pos?.seg ?? -1;
  /** Playhead position on the raw take's time axis. */
  const rawT = pos ? STARTS[pos.seg] + pos.offset : 0;
  const finalT = track === "final" ? t : keptElapsed(rawT);

  return (
    <section
      id="editing"
      className="mx-auto max-w-[1400px] px-6 py-20 md:px-12 md:py-24"
    >
      <Headline size="lg">
        You record it all. <span className="italic">We cut the awkward.</span>
      </Headline>
      <p className="mt-6 max-w-[720px] text-[17px] leading-[1.55] text-[#454545]">
        Bring in the whole take — false starts, long pauses, retakes and all.
        Donkey Cut finds the awkward moments, clips them out, and packs
        what&apos;s left into the finished video. Play any track — even the
        cutting-room floor.
      </p>

      <div className="relative mt-12">
        <div className="absolute inset-0 translate-x-[6px] translate-y-[6px] rounded-2xl bg-ink" />
        <div className="relative rounded-2xl border-2 border-ink bg-cream p-4 md:p-8">
          {/* Transport row */}
          <div className="flex items-center gap-3">
            <button
              aria-label={
                playing
                  ? `Pause ${TRACK_NAMES[track]}`
                  : `Play ${TRACK_NAMES[track]}`
              }
              className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full border-2 border-ink bg-coral transition-transform hover:scale-105"
              onClick={() => setPlaying((p) => !p)}
              type="button"
            >
              {playing ? (
                <Pause className="size-5" fill="currentColor" />
              ) : (
                <Play
                  className="size-5 translate-x-[1px]"
                  fill="currentColor"
                />
              )}
            </button>
            <div className="text-[14px] font-semibold first-letter:uppercase">
              {playing ? "Playing " : "Play "}
              {TRACK_NAMES[track]}
            </div>
            <div className="ml-auto rounded-md border-2 border-ink bg-white px-2 py-0.5 font-mono text-[12px] tabular-nums">
              {formatClock(TOTAL)} → {formatClock(TRACK_SECONDS.final)}
            </div>
          </div>

          <div className="mt-5">
            {/* Track 1: the whole recording. */}
            <div
              aria-pressed={track === "raw"}
              className={trackWrapperClass("raw")}
              onClick={() => selectTrack("raw")}
              onKeyDown={trackKeyHandler("raw")}
              role="button"
              tabIndex={0}
            >
              <TrackLabel
                n="1"
                seconds={TRACK_SECONDS.raw}
                selected={track === "raw"}
              >
                Raw footage
              </TrackLabel>
              <div className="relative mt-2 h-14 md:h-16">
                {SEGMENTS.map((s, i) => (
                  <div
                    key={s.label}
                    className={cn(
                      "absolute inset-y-0 overflow-hidden rounded-lg border-2 border-ink transition-opacity",
                      // Frame ticks so a placeholder tile reads as a strip of footage.
                      "bg-[repeating-linear-gradient(90deg,transparent,transparent_22px,rgba(15,14,13,0.14)_22px,rgba(15,14,13,0.14)_24px)]",
                      engaged && activeIndex !== i && "opacity-50",
                    )}
                    style={{
                      left: pct(STARTS[i]),
                      width: `calc(${pct(s.seconds)} - 4px)`,
                      backgroundColor: CARD[s.color],
                    }}
                  >
                    <span className="absolute top-1 left-1.5 hidden max-w-[calc(100%-12px)] truncate text-[10px] font-semibold md:block">
                      {s.label}
                    </span>
                    <span className="absolute right-1 bottom-1 hidden rounded bg-ink/70 px-1 font-mono text-[9px] tabular-nums text-white md:block">
                      {s.seconds.toFixed(1)}s
                    </span>
                  </div>
                ))}
                {engaged && <Playhead left={pct(rawT)} />}
              </div>
            </div>

            {/* Track 2: the discarded pieces, playable on their own so the
                viewer sees exactly what is getting clipped out. */}
            <div
              aria-pressed={track === "cut"}
              className={cn("mt-2", trackWrapperClass("cut"))}
              onClick={() => selectTrack("cut")}
              onKeyDown={trackKeyHandler("cut")}
              role="button"
              tabIndex={0}
            >
              <div className="flex items-center gap-2">
                <TrackLabel
                  n="2"
                  seconds={TRACK_SECONDS.cut}
                  selected={track === "cut"}
                >
                  Clipped out
                </TrackLabel>
                <Scissors className="size-3.5 text-ink/60" />
              </div>
              <div className="relative mt-2 h-10 md:h-12">
                {SEGMENTS.map(
                  (s, i) =>
                    !s.kept && (
                      <div
                        key={s.label}
                        className={cn(
                          "absolute inset-y-0 grid place-items-center overflow-hidden rounded-lg border-2 border-dashed transition-colors",
                          engaged && activeIndex === i
                            ? "border-coral bg-coral/15 text-ink"
                            : "border-ink/40 bg-white/40 text-ink/55",
                        )}
                        style={{
                          left: pct(STARTS[i]),
                          width: `calc(${pct(s.seconds)} - 4px)`,
                        }}
                      >
                        <span className="hidden max-w-full truncate px-1.5 text-center text-[10px] font-medium italic md:block">
                          {s.label}
                        </span>
                      </div>
                    ),
                )}
                {engaged && track !== "final" && <Playhead left={pct(rawT)} />}
              </div>
            </div>

            {/* Track 3: kept segments packed left. During the raw take its
                playhead stalls while the raw one crosses a clipped stretch. */}
            <div className="mt-4 border-t-2 border-dashed border-ink/25" />
            <div
              aria-pressed={track === "final"}
              className={cn("mt-4", trackWrapperClass("final"))}
              onClick={() => selectTrack("final")}
              onKeyDown={trackKeyHandler("final")}
              role="button"
              tabIndex={0}
            >
              <div className="flex items-center gap-2">
                <TrackLabel
                  n="3"
                  seconds={TRACK_SECONDS.final}
                  selected={track === "final"}
                >
                  Final cut
                </TrackLabel>
                <span className="rounded-md bg-ink px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {Math.round(TOTAL - TRACK_SECONDS.final)}s shorter
                </span>
              </div>
              <div className="relative mt-2 h-14 md:h-16">
                {SEGMENTS.map(
                  (s, i) =>
                    s.kept && (
                      <div
                        key={s.label}
                        className={cn(
                          "absolute inset-y-0 overflow-hidden rounded-lg border-2 border-ink transition-opacity",
                          "bg-[repeating-linear-gradient(90deg,transparent,transparent_22px,rgba(15,14,13,0.14)_22px,rgba(15,14,13,0.14)_24px)]",
                          engaged && activeIndex !== i && "opacity-50",
                        )}
                        style={{
                          left: pct(KEPT_STARTS[i]),
                          width: `calc(${pct(s.seconds)} - 4px)`,
                          backgroundColor: CARD[s.color],
                        }}
                      >
                        <span className="absolute top-1 left-1.5 hidden max-w-[calc(100%-12px)] truncate text-[10px] font-semibold md:block">
                          {s.label}
                        </span>
                      </div>
                    ),
                )}
                {engaged && track !== "cut" && <Playhead left={pct(finalT)} />}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
