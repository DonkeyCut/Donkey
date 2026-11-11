"use client";

import { useEffect, useRef, useState } from "react";
import { Clapperboard, Loader2, Volume2, VolumeX } from "lucide-react";
import { useTranslations } from "next-intl";
import { useDescribeError } from "@/i18n/describeError";
import { bindCutMode, releaseCutMode } from "@/cut/lib/backend";
import { bindTemplateBackend } from "@/cut/lib/backend/shared";
import { holdThreadsInMemory, releaseThreadsMemory } from "@/cut/lib/chatThreads";
import { holdEditorLoad } from "@/cut/lib/editorWork";
import { syncFontAssets } from "@/cut/lib/fontAssets";
// Side-effect import: registers the bundled Google font families, so titles
// set in them measure and draw in their own face.
import "@/cut/lib/googleFonts";
import { playheadAt } from "@/cut/lib/playhead";
import { setPreviewMuted, usePreviewMute } from "@/cut/lib/previewMute";
import { menuOnTop, shortcutDecline } from "@/cut/lib/shortcutGate";
import { projectDuration, useEditor } from "@/cut/lib/store";
import type { ShareFeatures } from "@/cut/lib/types";
import { templateFrame } from "@/cut/lib/templateGallery";
import { setFullTimeline, setLightTimeline } from "@/cut/lib/timelineDetail";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { TimelineActionButton } from "./TimelineActionButton";

// How near the end a stop has to land to count as the cut running out.
const END_SLACK_S = 0.05;
// How many seconds of a template the timeline fits as it opens.
const OPEN_SPAN_S = 30;

/**
 * A template in the editor's own stage over its timeline, as a share shows
 * a project: the document loads read-only through the backend the page
 * bound, plays as it opens, and loops. The picture is composited live from
 * the template's footage and elements, so what plays is the template itself,
 * and the timeline shows how it is built.
 */
export function TemplatePlayer({
  templateId,
  version,
  projectId,
  features,
}: {
  templateId: string;
  /** The published version, which keys the template's baked clip frames. */
  version: string;
  projectId: string;
  features: ShareFeatures;
}) {
  const describeError = useDescribeError();
  const loaded = useEditor((s) => s.loaded);
  const failure = useEditor((s) => s.loadFailure ?? s.loadError);
  // Until the load lands the store still holds whatever was open before.
  const stale = useEditor((s) => s.projectId) !== projectId;
  // Once a template has shown, the stage and timeline stay up while the next
  // one loads into them, so switching templates swaps the content in place.
  const [shown, setShown] = useState(false);
  if (loaded && !stale && !shown) {
    setShown(true);
  }

  // Uploaded fonts become live faces as the template's assets arrive.
  const assets = useEditor((s) => s.assets);
  useEffect(() => void syncFontAssets(assets), [assets]);

  // The read-only pin and in-memory threads last as long as the player.
  // Leaving closes the template and lets go of both, so the next page reads
  // and keeps the person's own projects and chats. The pin and its release
  // share this effect, so a remount binds again before it loads.
  const opened = useRef(projectId);
  useEffect(() => {
    opened.current = projectId;
  }, [projectId]);
  useEffect(() => {
    bindCutMode("shared");
    holdThreadsInMemory();
    return () => {
      useEditor.getState().closeProject(opened.current);
      releaseCutMode();
      releaseThreadsMemory();
      setFullTimeline();
      setPreviewMuted(false);
    };
  }, []);

  // The timeline draws this template's clips from the frames it baked.
  useEffect(() => {
    setLightTimeline((clipId) => templateFrame({ id: templateId, version }, clipId));
  }, [templateId, version]);

  // Load the template through its read-only backend, then play it. Another
  // template loads over this one in place.
  useEffect(() => {
    let alive = true;
    bindTemplateBackend(templateId);
    useEditor.getState().setSharedView(features);
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
    return () => {
      alive = false;
    };
  }, [templateId, projectId, features]);

  // The cut running out starts it again from the top. The playback tick
  // that stops at the end writes the playhead there after it announces the
  // stop, so the restart waits for that tick to finish.
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (!prev.playing || s.playing || s.projectId !== projectId) {
          return;
        }
        queueMicrotask(() => {
          const now = useEditor.getState();
          const total = projectDuration(now);
          if (now.playing || now.projectId !== projectId || total <= 0 || playheadAt() < total - END_SLACK_S) {
            return;
          }
          now.seek(0);
          now.setPlaying(true);
        });
      }),
    [projectId]
  );

  // Space plays and pauses, as in the editor, rewinding first from the end.
  // A typing field, a dialog or an open menu keeps its own Space; a focused
  // button does not, so the key never re-presses the last one clicked. The
  // player takes the key first and keeps it, so an editor left mounted on a
  // hidden page never toggles playback back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      if (shortcutDecline(e) || menuOnTop()) {
        return;
      }
      const s = useEditor.getState();
      const total = projectDuration(s);
      if (s.projectId !== projectId || total <= 0) {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!s.playing && playheadAt() >= total - END_SLACK_S) {
        s.seek(0);
      }
      s.setPlaying(!s.playing);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [projectId]);

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

  if ((!loaded || stale) && !shown) {
    return (
      <div className="grid h-full place-items-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]">
      <Preview />
      <div className="relative min-w-0">
        <Timeline fold="fixed" openSpan={OPEN_SPAN_S} toolbarStart={<MuteButton />} />
      </div>
    </div>
  );
}

/** The template's sound on or off; the picture plays on either way. */
function MuteButton() {
  const t = useTranslations("timeline.media");
  const muted = usePreviewMute((s) => s.muted);
  const label = muted ? t("unmute") : t("mute");
  return (
    <TimelineActionButton label={label} tooltip={label} pressed={muted} onClick={() => setPreviewMuted(!muted)}>
      {muted ? <VolumeX /> : <Volume2 />}
    </TimelineActionButton>
  );
}
