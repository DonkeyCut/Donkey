"use client";

/**
 * Dev-only automation hooks: expose the Cut stores on window so a real-model
 * eval (a headless browser driving the actual pipeline) can start runs and
 * read progress deterministically instead of scraping the UI. Installed from
 * the editor root; a no-op in production builds.
 */

import { renderProjectToMp4 } from "./exportRender";
import { useGenerate } from "./generate";
import { useGenScene } from "./genScene";
import { edgeFramesPending, enrichAsset, importFileToProject } from "./media";
import { awaitingFrame, startTrace, stopTrace, traceReport } from "./perfTrace";
import { playheadAt } from "./playhead";
import { projectDuration, useEditor } from "./store";

export function installDevHooks(): void {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__cutDev = {
    useEditor,
    useGenerate,
    useGenScene,
    importFileToProject,
    enrichAsset,
    // The filmstrip eval waits on zero pending captures before it reads the
    // strip's tiles back out of the DOM.
    edgeFramesPending,
    playheadAt,
    // The export eval renders a doc through the tab's own pipeline and reads
    // the bytes back out.
    renderProjectToMp4,
    projectDuration,
  };
  // The perf eval arms and reads the frame trace through here. Off until
  // `start()` is called, so an ordinary dev session records nothing.
  (window as unknown as Record<string, unknown>).__cutPerf = {
    start: startTrace,
    stop: stopTrace,
    awaiting: awaitingFrame,
    /** Stop recording and answer with the summary. */
    report: () => {
      const trace = stopTrace();
      return trace ? traceReport(trace) : null;
    },
  };
}
