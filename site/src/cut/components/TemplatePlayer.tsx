"use client";

import { useEffect } from "react";
import { Clapperboard, Loader2 } from "lucide-react";
import { useDescribeError } from "@/i18n/describeError";
import { releaseCutMode } from "@/cut/lib/backend";
import { holdEditorLoad } from "@/cut/lib/editorWork";
import { syncFontAssets } from "@/cut/lib/fontAssets";
// Side-effect import: registers the bundled Google font families, so titles
// set in them measure and draw in their own face.
import "@/cut/lib/googleFonts";
import { playheadAt } from "@/cut/lib/playhead";
import { projectDuration, useEditor } from "@/cut/lib/store";
import { Preview } from "./Preview";

// How near the end a stop has to land to count as the cut running out.
const END_SLACK_S = 0.05;

/**
 * A template playing in the editor's own stage, with nothing else of the
 * editor: the document loads read-only through the backend the page bound,
 * plays as it opens, and loops. The picture is composited live from the
 * template's footage and elements, so what plays is the template itself.
 */
export function TemplatePlayer({ projectId }: { projectId: string }) {
  const describeError = useDescribeError();
  const loaded = useEditor((s) => s.loaded);
  const failure = useEditor((s) => s.loadFailure ?? s.loadError);
  // Until the load lands the store still holds whatever was open before.
  const stale = useEditor((s) => s.projectId) !== projectId;

  // Uploaded fonts become live faces as the template's assets arrive.
  const assets = useEditor((s) => s.assets);
  useEffect(() => void syncFontAssets(assets), [assets]);

  // Load the template read-only, then play it.
  useEffect(() => {
    let alive = true;
    void holdEditorLoad().then(async (release) => {
      try {
        if (!alive) {
          return;
        }
        await useEditor.getState().loadProject(projectId, { viewer: true });
        if (alive) {
          useEditor.getState().setPlaying(true);
        }
      } finally {
        release();
      }
    });
    // Leaving closes the template and lets go of the read-only backend the
    // page pinned, so the next page reads the person's own projects.
    return () => {
      alive = false;
      useEditor.getState().closeProject(projectId);
      releaseCutMode();
    };
  }, [projectId]);

  // The cut running out starts it again from the top.
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (!prev.playing || s.playing || s.projectId !== projectId) {
          return;
        }
        const total = projectDuration(s);
        if (total > 0 && playheadAt() >= total - END_SLACK_S) {
          s.seek(0);
          s.setPlaying(true);
        }
      }),
    [projectId]
  );

  if (failure && !stale) {
    return (
      <div className="grid h-full place-items-center px-4">
        <div className="flex flex-col items-center gap-3 text-center">
          <Clapperboard className="size-7 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{describeError(failure)}</p>
        </div>
      </div>
    );
  }

  if (!loaded || stale) {
    return (
      <div className="grid h-full place-items-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 min-w-0">
      <Preview mode="play" />
    </div>
  );
}
