"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleDashed,
  Clapperboard,
  Maximize2,
  RotateCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHoverPlay } from "../hooks/useHoverPlay";
import { refFromAsset, type AssetRef } from "../lib/assetRef";
import { lightboxItemFromRef, useLightbox } from "../lib/lightbox";
import { formatDuration, useGenScene, type SceneRun } from "../lib/genScene";
import { NO_CREDITS_MESSAGE } from "../lib/generate";
import { GEN_FPS } from "../lib/genvideo/editorBridge";
import { useEditor } from "../lib/store";
import { formatTime } from "../lib/time";
import { frameOf, type MediaAsset } from "../lib/types";
import type { Shot, ShotStatus } from "../lib/genvideo/types";
import { cn } from "@/lib/utils";
import { HostedErrorText } from "./hostedError";
import { scrimIconButton } from "./iconButton";
import { RefThumb } from "./AssetRefs";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";

// The brief-to-video progress card, pinned into the chat while a "generate a
// video" run is planning, waiting for approval, or rendering. The timeline fills
// on its own via the editor bridge; this is the control surface — approve the
// plan, watch shots land, redo one by clicking its chip.

const STATUS_LABEL: Record<SceneRun["status"], string> = {
  planning: "Planning",
  awaiting_approval: "Storyboard ready",
  generating: "Rendering",
  done: "Done",
  failed: "Failed",
};

/** mm:ss for a frame count at the plan's fixed rate. */
function fmt(frames: number): string {
  return formatDuration((frames / GEN_FPS) * 1000);
}

/** A single shot's own length in seconds, for the filmstrip badge ("3.2s"). */
function shotSecs(sh: Shot): string {
  return `${((sh.endFrame - sh.startFrame) / GEN_FPS).toFixed(1)}s`;
}

/** The shot statuses that mean a render is actively in flight. */
const SHOT_INFLIGHT = new Set<ShotStatus>(["keyframing", "generating", "lipsync", "reviewing"]);

/** The one line a plan row shows — what's on screen, else the spoken line. */
function describe(sh: Shot): string {
  return sh.action?.trim() || sh.dialogue?.trim() || sh.audioText?.trim() || "—";
}

export function SceneCard({ threadId }: { threadId: string }) {
  const run = useGenScene((s) => s.run);
  const projectId = useEditor((s) => s.projectId);
  const [open, setOpen] = useState(true);

  // Resuming a persisted run is the genScene store's own subscription — it
  // must happen even when this card (or the whole AI panel) never mounts.

  // The elapsed clock's "now", advanced once a second while the run works.
  // Held in state — Date.now() in render is impure — and set only from the
  // interval, so the first second shows 0:00 and a settled card renders from
  // its stamped times (a stale value clamps to zero, never shows).
  const [now, setNow] = useState<number | null>(null);
  const working = run?.status === "planning" || run?.status === "generating";
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  if (!run || run.projectId !== projectId) return null;
  // The card belongs to the thread that asked — a new or different chat starts
  // clean. A run with no owner (pre-chatId persisted plans) shows anywhere.
  if (run.chatId && run.chatId !== threadId) return null;

  const inFlight = run.status === "planning" || run.status === "generating";
  const canDismiss =
    run.status === "awaiting_approval" || run.status === "done" || run.status === "failed";
  const pct = run.total ? Math.round((run.placed / run.total) * 100) : 0;
  const showProgress = run.status === "generating" || run.status === "done";
  const totalFrames = run.shots.length ? Math.max(...run.shots.map((sh) => sh.endFrame)) : 0;
  // Whether any shot has something to show yet — a landed take or its opening
  // frame. Until one does, the tile grid would be blank placeholders.
  const hasFrames = run.shots.some((sh) => sh.clip || sh.startKeyframe);
  // Shots that couldn't be rendered as video and are holding a still instead.
  const stillCount = run.shots.filter((sh) => sh.status === "failed").length;
  // Any shot stopped by an empty balance: the summary names the cause (the
  // composer's credits tab carries the reload link).
  const creditsOut = run.shots.some(
    (sh) => sh.status === "failed" && sh.error === NO_CREDITS_MESSAGE
  );
  // Why they held: the first failed shot's own error, so the notice names the
  // cause instead of stating that something failed.
  const stillReason = run.shots.find((sh) => sh.status === "failed" && sh.error)?.error;
  // Elapsed clock: planning counts from the run start, rendering from approval;
  // it stops at the end. Hidden while waiting for the user at the gate.
  const clockAnchor = run.status === "planning" ? run.startedAt : run.renderStartedAt ?? run.startedAt;
  const clockEnd = inFlight ? now ?? run.startedAt : run.endedAt ?? run.startedAt;
  const elapsed = run.status === "awaiting_approval" ? null : formatDuration(clockEnd - clockAnchor);

  return (
    <div className="ai-scene-card mt-2 rounded-xl border border-border bg-card/60 p-3 text-[11.5px]">
      <div className="flex items-center gap-1.5">
        <Clapperboard className="size-3.5 text-[#0a84ff]" />
        <span className="font-semibold">Generate video</span>
        <span className="ml-auto flex items-center gap-1 text-[10.5px] text-muted-foreground">
          {inFlight && <CircleDashed className="size-3 animate-spin" />}
          {STATUS_LABEL[run.status]}
          {elapsed && <span className="tabular-nums">· {elapsed}</span>}
        </span>
      </div>

      <p className="mt-1 line-clamp-2 text-muted-foreground">{run.title}</p>

      {run.shots.length > 0 &&
        (hasFrames ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="flex w-full items-center gap-1.5 py-0.5 text-left text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
              />
              <span className="font-medium text-foreground">Plan</span>
              <span>
                {run.shots.length} shot{run.shots.length === 1 ? "" : "s"} · {fmt(totalFrames)}
              </span>
              {showProgress && (
                <span className="ml-auto tabular-nums text-[10.5px]">
                  {run.placed}/{run.total} placed
                </span>
              )}
            </button>

            {open && (
              <ShotStrip
                run={run}
                redoable={run.status === "done" || run.status === "awaiting_approval"}
                atGate={run.status === "awaiting_approval"}
              />
            )}
          </div>
        ) : (
          // Nothing rendered yet (planning, at the gate, or a run that died
          // before its frames): the tiles would be blank placeholders, so state
          // the plan as a line and let shots appear as they actually render.
          <p className="mt-2 flex items-center gap-1.5">
            <span className="font-medium">Plan</span>
            <span className="text-muted-foreground">
              {run.shots.length} shot{run.shots.length === 1 ? "" : "s"} · {fmt(totalFrames)}
            </span>
          </p>
        ))}

      {run.status === "generating" && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-[#0a84ff] transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {run.error && (
        <p className="mt-2 flex items-start gap-1.5 text-amber-700">
          <TriangleAlert className="mt-px size-3 shrink-0" />
          <span>
            <HostedErrorText error={run.error} link={false} />
          </span>
        </p>
      )}

      {canDismiss && (
        <div className="mt-2.5 flex flex-col gap-1.5">
          {/* The stills notice reads as a paragraph, so it takes its own line
              above the buttons rather than sharing a row with them. */}
          {run.status === "done" && stillCount > 0 && (
            <span className="flex items-start gap-1 text-[10.5px] text-amber-700">
              <TriangleAlert className="mt-px size-3 shrink-0" />
              <span>
                {stillCount} of {run.shots.length} shot{run.shots.length === 1 ? "" : "s"} held a
                still —{" "}
                {creditsOut || stillReason ? (
                  <HostedErrorText error={creditsOut ? NO_CREDITS_MESSAGE : stillReason!} link={false} />
                ) : (
                  "video generation failed"
                )}
              </span>
            </span>
          )}
          <div className="flex items-center gap-1.5">
            {run.status === "awaiting_approval" && (
              <Button
                size="sm"
                className="h-7 flex-1 text-[11.5px]"
                onClick={() => useGenScene.getState().approve()}
              >
                Approve &amp; render{run.shots.length ? ` (${run.shots.length})` : ""}
              </Button>
            )}
            {run.status === "failed" && (
              // Failed is a deliberate stop (nothing auto-resumes it); the run
              // continues only through this click, skipping work already done.
              <Button
                size="sm"
                className="h-7 flex-1 text-[11.5px]"
                onClick={() => useGenScene.getState().retryRun()}
              >
                Retry
              </Button>
            )}
            {run.status === "done" && stillCount === 0 && (
              <span className="flex flex-1 items-center gap-1 text-emerald-600">
                <Check className="size-3.5" /> Video ready
              </span>
            )}
            {run.status === "done" && stillCount > 0 && (
              <Button
                size="sm"
                className="h-7 flex-1 text-[11.5px]"
                onClick={() => useGenScene.getState().retryFailedShots()}
              >
                Retry {stillCount} shot{stillCount === 1 ? "" : "s"}
              </Button>
            )}
            {canDismiss && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-muted-foreground"
                title="Dismiss"
                onClick={() => useGenScene.getState().dismiss()}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The plan as a two-up grid — two shots per row, top to bottom the way the
 * finished scenes read: each shot's opening frame (then its take once it
 * renders), a duration badge, and its "Shot N" heading with what's on screen.
 * Numbered placeholders with the planned description stand in while the frames
 * are still being cut, so the same grid carries the run from plan through
 * render without changing shape. */
function ShotStrip({
  run,
  redoable,
  atGate,
}: {
  run: SceneRun;
  redoable: boolean;
  atGate: boolean;
}) {
  const assets = useEditor((s) => s.assets);
  const aspect = useEditor((s) => s.aspect);
  const baseFrame = frameOf(aspect);
  const baseRatio = baseFrame.w / baseFrame.h;
  return (
    <div className="ai-scene-strip mt-1.5 grid grid-cols-2 gap-1.5">
      {run.shots.map((sh, i) => (
        <ShotTile
          key={sh.id}
          shot={sh}
          n={i + 1}
          assets={assets}
          baseRatio={baseRatio}
          redoable={redoable}
          atGate={atGate}
        />
      ))}
    </div>
  );
}

/** One grid tile: the shot's take once placed, else its opening frame, else a
 * numbered placeholder over the planned description — so a shot reads before it
 * has a frame. Click opens whatever exists in the lightbox. The hover redo
 * button works in two places: at the storyboard gate it re-draws just this
 * frame (a cheap image, nothing rendered yet), and once the run is done it
 * re-renders the whole shot. Tiles are borderless so the grid stays flat. */
function ShotTile({
  shot,
  n,
  assets,
  baseRatio,
  redoable,
  atGate,
}: {
  shot: Shot;
  n: number;
  assets: MediaAsset[];
  baseRatio: number;
  redoable: boolean;
  atGate: boolean;
}) {
  const clip = shot.clip ? assets.find((a) => a.id === shot.clip) : undefined;
  const frame = shot.startKeyframe ? assets.find((a) => a.id === shot.startKeyframe) : undefined;
  const media = clip ?? frame;
  const ref = media ? refFromAsset(media) : undefined;
  const ratio = media?.width && media?.height ? media.width / media.height : baseRatio;
  const inFlight = SHOT_INFLIGHT.has(shot.status);
  const view = () => ref && useLightbox.getState().open(lightboxItemFromRef(ref));
  const { ref: videoRef, handlers: hoverPlay } = useHoverPlay();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        onClick={view}
        title={`Shot ${n} — ${describe(shot)}`}
        className={cn(
          "group relative w-full overflow-hidden rounded-md bg-muted transition-opacity",
          ref ? "cursor-zoom-in hover:opacity-95" : "cursor-default"
        )}
        // The tile fills its column at the run's aspect; a tall 9:16 shot is
        // capped so two columns of a long plan stay a scannable height.
        style={{ aspectRatio: ratio, maxHeight: baseRatio < 1 ? 200 : undefined }}
        {...(clip && ref ? hoverPlay : {})}
      >
        {clip && ref ? (
          <video crossOrigin={MEDIA_CORS}
            ref={videoRef}
            src={`${ref.url}#t=0.1`}
            preload="metadata"
            muted
            loop
            playsInline
            className="size-full object-cover"
          />
        ) : frame && ref ? (
          // eslint-disable-next-line @next/next/no-img-element -- engine/static file, not Next-optimizable
          <img crossOrigin={MEDIA_CORS} src={ref.url} alt="" className="size-full object-cover" />
        ) : (
          <span className="grid size-full place-items-center text-[13px] font-semibold text-muted-foreground/50">
            {inFlight ? <CircleDashed className="size-4 animate-spin text-[#0a84ff]" /> : n}
          </span>
        )}

        {/* A frame that's still animating: dim it and spin over the top. */}
        {inFlight && media && (
          <span className="absolute inset-0 grid place-items-center bg-black/35">
            <CircleDashed className="size-4 animate-spin text-white" />
          </span>
        )}

        {shot.status === "placed" && (
          <span className="absolute top-1 left-1 grid size-3.5 place-items-center rounded-full bg-emerald-500 text-white">
            <Check className="size-2.5" />
          </span>
        )}
        {shot.status === "failed" && (
          <span className="absolute top-1 left-1 rounded bg-amber-500/90 px-1 text-[8.5px] font-medium text-white">
            still
          </span>
        )}

        <span className="absolute right-1 bottom-1 rounded bg-black/65 px-1 font-mono text-[9px] text-white tabular-nums">
          {shotSecs(shot)}
        </span>

        {redoable && (
          <button
            type="button"
            title={atGate ? "Redraw this frame" : "Redo this shot"}
            onClick={(e) => {
              e.stopPropagation();
              useGenScene.getState().regenerateShot(n);
            }}
            className={cn(
              scrimIconButton,
              "absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100"
            )}
          >
            <RotateCw className="size-3" />
          </button>
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[9.5px] font-medium text-foreground">Shot {n}</div>
        <p className="line-clamp-2 text-[9px] leading-snug text-muted-foreground">{describe(shot)}</p>
      </div>
    </div>
  );
}

/** The run's chronological record, streamed into the chat as its own item
 * right under the scene card — every narrated step and every asset it made,
 * thumbnails included. Nothing the run does is internal: this is the same
 * story the agent would tell in chat. */
export function SceneActivity({ threadId }: { threadId: string }) {
  const run = useGenScene((s) => s.run);
  const projectId = useEditor((s) => s.projectId);
  // Feed thumbnails resolve against the open project's media (the run's
  // assets are project assets, chat-owned).
  const assets = useEditor((s) => s.assets);

  // Follow new entries only when the chat is already reading the tail —
  // never yank the user back down while they scroll through old images.
  const bottomRef = useRef<HTMLDivElement>(null);
  const feedLen = run?.feed.length ?? 0;
  useEffect(() => {
    const scroller = bottomRef.current?.closest(".ai-messages");
    if (!scroller) return;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (gap < 160) scroller.scrollTop = scroller.scrollHeight;
  }, [feedLen]);

  if (!run || run.projectId !== projectId) return null;
  if (run.chatId && run.chatId !== threadId) return null;
  if (run.feed.length === 0) return null;
  const inFlight = run.status === "planning" || run.status === "generating";

  return (
    <div className="ai-scene-activity mt-2 mb-3 flex flex-col gap-1.5">
      <div className="text-[10.5px] font-medium text-muted-foreground">Activity</div>
      {run.feed.map((f, i) => {
        const asset = f.mediaId ? assets.find((a) => a.id === f.mediaId) : undefined;
        const ref = asset ? refFromAsset(asset) : undefined;
        const latest = i === run.feed.length - 1;
        return (
          <FeedEntry
            key={`${f.at}-${i}`}
            text={f.text}
            item={ref}
            asset={asset}
            pulse={latest && inFlight}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

/** One feed line. Clicking the thumbnail expands the media in place — the same
 * inline tile chat asset cards use — and a second click collapses it back;
 * the tile's corner button opens the lightbox. */
function FeedEntry({
  text,
  item,
  asset,
  pulse,
}: {
  text: string;
  item?: AssetRef;
  asset?: MediaAsset;
  pulse: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { ref: videoRef, handlers: hoverPlay } = useHoverPlay();
  const inPlace = item?.kind === "image" || item?.kind === "video";
  const caption = (
    <span
      className={`min-w-0 flex-1 text-[11px] text-muted-foreground ${pulse ? "animate-pulse" : ""}`}
    >
      {text}
    </span>
  );

  if (item && inPlace && expanded) {
    const ratio =
      asset?.width && asset?.height
        ? asset.width / asset.height
        : item.kind === "image"
          ? 1
          : 16 / 10;
    const width = Math.round(Math.min(248, Math.max(132, 210 * ratio)));
    return (
      <div className="flex flex-col items-start gap-1">
        <div
          className="group relative cursor-zoom-out overflow-hidden rounded-xl border border-border bg-muted"
          style={{ width, aspectRatio: ratio }}
          title={`${item.name} — click to minimize`}
          onClick={() => setExpanded(false)}
          {...(item.kind === "video" ? hoverPlay : {})}
        >
          {item.kind === "video" ? (
            <video crossOrigin={MEDIA_CORS}
              ref={videoRef}
              src={`${item.url}#t=0.1`}
              preload="metadata"
              muted
              loop
              playsInline
              className="size-full object-cover"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- engine/static file, not Next-optimizable
            <img crossOrigin={MEDIA_CORS} src={item.url} alt={item.name} className="size-full object-cover" />
          )}
          {item.kind === "video" && item.duration !== undefined && (
            <span className="absolute right-1.5 bottom-1.5 rounded-[5px] bg-black/65 px-1 py-px font-mono text-[9px] text-white tabular-nums">
              {formatTime(item.duration)}
            </span>
          )}
          <button
            title="Expand"
            className={cn(
              scrimIconButton,
              "absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100"
            )}
            onClick={(e) => {
              e.stopPropagation();
              useLightbox.getState().open(lightboxItemFromRef(item));
            }}
          >
            <Maximize2 className="size-3" />
          </button>
        </div>
        {caption}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {item && (
        <button
          type="button"
          title={`${item.name} — click to view`}
          className="shrink-0"
          onClick={() =>
            inPlace
              ? setExpanded(true)
              : useLightbox.getState().open(lightboxItemFromRef(item))
          }
        >
          <RefThumb item={item} className="size-8 rounded-[4px]" />
        </button>
      )}
      {caption}
    </div>
  );
}
