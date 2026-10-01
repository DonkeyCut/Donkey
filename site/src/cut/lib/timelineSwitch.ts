import { useEffect, useState } from "react";
import { engineFeatures } from "./api";
import { getBackend } from "./backend";
import { projectHasLiveRun, useGenScene } from "./genScene";
import { useMatteBakes, type MatteBakeJob } from "./removal/bakeJobs";
import { useEditor } from "./store";
import { TIMELINE_LABELS, type TimelineId } from "./types";

/** Whether the open project's storage keeps more than one timeline. An engine
 * from before timelines rebuilds the saved doc without the parked ones, so a
 * Mac project on an older app stays on Main. A headless turn runs inside the
 * same build that stores the doc. */
export async function timelinesSupported(): Promise<boolean> {
  if (typeof window === "undefined" || getBackend().kind !== "local") return true;
  return (await engineFeatures()).has("doc.timelines");
}

const baking = (jobs: Record<string, MatteBakeJob>) => Object.values(jobs).some((j) => j.status === "running");

/** Why the open timeline cannot be left right now, or null when it can. Work
 * still landing on it — a scene run placing shots, captions being written, a
 * cutout matte baking — belongs to the timeline it started on. */
export function timelineSwitchBlocker(): string | null {
  const s = useEditor.getState();
  const open = TIMELINE_LABELS[s.timeline];
  if (s.readOnly) return "A shared project is read-only.";
  if (s.projectId && projectHasLiveRun(s.projectId))
    return `A scene run is placing shots on ${open}; switch once it finishes.`;
  if (s.subtitleStatus === "running") return `Subtitles are being written on ${open}; switch once they land.`;
  if (baking(useMatteBakes.getState().jobs)) return `A cutout is baking on ${open}; switch once it lands.`;
  return null;
}

/** Open another of the project's timelines, or say why it cannot. */
export async function switchTimeline(id: TimelineId): Promise<string | null> {
  if (!(await timelinesSupported())) return "Update the Donkey app to use more than one timeline.";
  const blocked = timelineSwitchBlocker();
  if (blocked) return blocked;
  useEditor.getState().switchTimeline(id);
  return null;
}

/** The picker's state: hidden where the storage cannot keep timelines, held
 * while work is still landing on the open one. */
export function useTimelinePicker(): { supported: boolean; blocked: boolean } {
  const projectId = useEditor((s) => s.projectId);
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let live = true;
    void timelinesSupported().then((ok) => live && setSupported(ok));
    return () => {
      live = false;
    };
  }, [projectId]);
  const captions = useEditor((s) => s.subtitleStatus === "running");
  const run = useGenScene(
    (g) => !!g.run && g.run.projectId === projectId && g.run.status !== "done" && g.run.status !== "failed"
  );
  const matte = useMatteBakes((m) => baking(m.jobs));
  return { supported, blocked: captions || run || matte };
}
