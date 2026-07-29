"use client";

import { useEffect, useRef, useState } from "react";

import "./editor-mock.css";

import { MockAiPanel } from "@/cut/components/editor-mock/MockAiPanel";
import { MockPreview } from "@/cut/components/editor-mock/MockPreview";
import { MockSidePanel } from "@/cut/components/editor-mock/MockSidePanel";
import { MockTimeline } from "@/cut/components/editor-mock/MockTimeline";
import { MockTopBar } from "@/cut/components/editor-mock/MockTopBar";
import { MOCK_PROJECTS } from "@/cut/components/editor-mock/mockData";
import { cn } from "@/lib/utils";

// The mock is authored at a fixed design size and scaled to its container's
// width, so its internals never reflow — it behaves like a live screenshot.
const DESIGN_W = 1200;
const DESIGN_H = 726;

// Which slice of that design is on screen. "full" is the whole editor; "ai"
// drops the side panel and keeps the preview, timeline, and chat column, which
// is how the same mock reads as a different picture when the subject is the
// assistant.
const VIEWS = {
  full: { x: 0, w: DESIGN_W },
  ai: { x: 300, w: DESIGN_W - 300 },
} as const;

export type EditorMockView = keyof typeof VIEWS;

type Props = {
  view?: EditorMockView;
  /** Which dimension the mock is sized by. "width" fills the container and
   * takes whatever height that implies; "height" fills a container of bounded
   * height and takes whatever width that implies; "contain" takes the smaller
   * of the two and centers, so the whole mock is always on screen whichever
   * way the container is short. */
  fit?: "width" | "height" | "contain";
  /** The dots that switch projects. Off where the mock is one slide of a
   * larger sequence and the only navigation should be that sequence's. */
  showSwitcher?: boolean;
  /** The drop shadow that lifts the mock off the page. Off where the frame is
   * meant to sit flat on the surface — a shadow doesn't dissolve, so it
   * outlines the mock wherever the edges are supposed to fade away. */
  shadow?: boolean;
};

// A hand-built, display-only replica of the Cut editor showing two finished
// projects. The panels copy the real components' chrome (see the Mock*
// siblings) over hardcoded data — no stores, no engine. The dots below switch
// projects; nothing auto-advances.
export function EditorMock({
  view = "full",
  fit = "width",
  showSwitcher = true,
  shadow = true,
}: Props) {
  const [active, setActive] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { x, w } = VIEWS[view];
  const byWidth = box.width / w;
  const byHeight = box.height / DESIGN_H;
  const scale =
    fit === "height"
      ? byHeight
      : fit === "contain"
        ? Math.min(byWidth, byHeight)
        : byWidth;

  return (
    <figure
      className={cn("m-0 flex min-h-0 flex-col", fit !== "width" && "h-full")}
    >
      <div
        ref={frameRef}
        className={cn(
          "w-full",
          fit === "height" && "min-h-0 flex-1",
          fit === "contain" && "flex min-h-0 flex-1 items-center justify-center",
        )}
      >
        {/* Sized by width, the box holds its shape from the aspect ratio alone,
            so the space it will occupy is right before the first measurement
            and the page never jumps under it. */}
        <div
          className={cn(
            "overflow-hidden rounded-2xl bg-card",
            shadow
              ? "shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_24px_64px_rgba(15,14,13,0.25)]"
              : "shadow-[0_0_0_1px_rgba(0,0,0,0.06)]",
          )}
          style={
            fit === "width"
              ? { width: "100%", aspectRatio: `${w} / ${DESIGN_H}` }
              : { width: Math.round(w * scale), height: Math.round(DESIGN_H * scale) }
          }
        >
          <div
            aria-hidden
            className="pointer-events-none relative origin-top-left overflow-hidden bg-card font-system text-foreground antialiased select-none"
            style={{
              width: DESIGN_W,
              height: DESIGN_H,
              transform: `scale(${scale}) translateX(${-x}px)`,
            }}
          >
            {MOCK_PROJECTS.map((project, i) => (
              <div
                key={project.id}
                className={cn(
                  // Same frame as the real editor: the chat panel is a
                  // full-height column beside the top-bar/preview/timeline grid.
                  "absolute inset-0 flex bg-card transition-opacity duration-300",
                  i === active ? "opacity-100" : "opacity-0",
                )}
              >
                <div className="grid min-w-0 flex-1 grid-rows-[46px_minmax(0,1fr)_auto]">
                  <MockTopBar project={project} />
                  <div className="grid min-h-0 grid-cols-[auto_minmax(0,1fr)]">
                    <MockSidePanel project={project} />
                    <MockPreview project={project} active={i === active} />
                  </div>
                  <MockTimeline project={project} />
                </div>
                <MockAiPanel project={project} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <figcaption className="sr-only">
        The Donkey Cut editor with a finished project open: generated media in
        the side panel, clips and music on the timeline, and the AI chat that
        assembled them.
      </figcaption>
      {showSwitcher && (
        <div className="mt-6 flex flex-wrap justify-center gap-1.5">
          {MOCK_PROJECTS.map((project, i) => (
            <button
              key={project.id}
              type="button"
              onClick={() => setActive(i)}
              aria-pressed={i === active}
              className={cn(
                "flex items-center gap-1.5 rounded-full border border-ink px-2.5 py-3 text-xs font-medium transition-colors",
                i === active ? "bg-ink text-white" : "bg-white text-ink hover:bg-ink/5",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  i === active ? "bg-coral" : "bg-ink/25",
                )}
              />
              {project.switcherLabel}
            </button>
          ))}
        </div>
      )}
    </figure>
  );
}
