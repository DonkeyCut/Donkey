"use client";

import { useEffect, useState, type ReactNode } from "react";
import type React from "react";
import { Copy, ExternalLink, FileText, Film, Loader2, Maximize2, Plus } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { clearAssetDrag, setAssetDragData, setChipDragImage } from "@/cut/lib/assetDrag";
import {
  projectRefs,
  refFromAsset,
  refToken,
  setRefDragData,
  type AssetRef,
  type AssetRefKind,
} from "@/cut/lib/assetRef";
import { useElapsed } from "@/cut/hooks/useElapsed";
import { useHoverPlay } from "@/cut/hooks/useHoverPlay";
import { useInView } from "@/cut/hooks/useInView";
import { useGenerate, type GenerateJob } from "@/cut/lib/generate";
import { lightboxItemFromRef, useLightbox } from "@/cut/lib/lightbox";
import { usePreviewAudio } from "@/cut/lib/previewAudio";
import { useEditor } from "@/cut/lib/store";
import { formatTime } from "@/cut/lib/time";
import type { MediaAsset } from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { AudioRow } from "./AudioPanel";
import { DocText, useDocText } from "./DocText";
import { GeneratedAssetMenu } from "./GeneratedAssetMenu";
import { scrimIconButton } from "./iconButton";
import { HostedErrorText } from "./hostedError";

// Assets rendered inside chat messages. Anything the assistant makes previews
// here as a media-first card and stays in the chat until the user moves it:
// drag it onto the timeline (standard payloads), or use the card's "…" menu to
// add it to the timeline, Media, or the Library. Double-click — or the expand
// button — opens the lightbox. Cards register per asset kind, so new
// renderable kinds (motion graphics, stickers) plug in beside video, image,
// audio, and text.

/** What a per-kind chat card receives: the ref as recorded in the message and,
 * when it names a live project asset, that asset (fresher name/peaks/size). */
interface ChatCardProps {
  item: AssetRef;
  asset?: MediaAsset;
}

const CHAT_CARDS: Record<AssetRefKind, (props: ChatCardProps) => ReactNode> = {
  video: MediaCard,
  image: MediaCard,
  audio: AudioCard,
  text: DocCard,
};

export function ChatAssetCard({ item }: { item: AssetRef }) {
  const asset = useEditor((s) =>
    item.scope === "project" ? s.assets.find((a) => a.id === item.id) : undefined
  );
  // A project ref whose asset is gone has nothing left to preview.
  if (item.scope === "project" && !asset) return null;
  const Card = CHAT_CARDS[item.kind];
  return <Card item={item} asset={asset} />;
}

/** Chat card for a project asset id — how tool outputs name what they made. */
export function ChatProjectAsset({ assetId }: { assetId: string }) {
  const asset = useEditor((s) => s.assets.find((a) => a.id === assetId));
  if (!asset) return null;
  return <ChatAssetCard item={refFromAsset(asset)} />;
}

/** The assets a finished tool call produced, from its typed output fields:
 * `assetId` for landed media, `jobId` for a video render still in flight,
 * `stillAssetId` for a staged render's opening frame (shown above its job). */
export function ToolOutputAssets({ output }: { output: unknown }) {
  if (!output || typeof output !== "object") return null;
  const o = output as {
    assetId?: unknown;
    jobId?: unknown;
    stillAssetId?: unknown;
    assets?: unknown;
  };
  // Tools that land several assets at once (import_url on an X post's photos, a
  // video plus its poster) list them under `assets`, each with its own assetId
  // — one card per asset. A listing like library_list keys entries by `id`, not
  // `assetId`, so it renders nothing here.
  const many = Array.isArray(o.assets)
    ? o.assets
        .map((a) => (a && typeof a === "object" ? (a as { assetId?: unknown }).assetId : undefined))
        .filter((id): id is string => typeof id === "string")
    : [];
  return (
    <>
      {typeof o.stillAssetId === "string" && <ChatProjectAsset assetId={o.stillAssetId} />}
      {many.map((id) => (
        <ChatProjectAsset key={id} assetId={id} />
      ))}
      {typeof o.assetId === "string" ? (
        <ChatProjectAsset assetId={o.assetId} />
      ) : typeof o.jobId === "string" ? (
        <ChatVideoJobCard jobId={o.jobId} />
      ) : null}
    </>
  );
}

/** How long a mirrored "running" record with no live job stays believable —
 * another machine may genuinely still be polling the render. Past this, the
 * job died without settling its record; show that instead of a forever
 * spinner. */
export const RECORD_RUNNING_TTL_MS = 30 * 60_000;

/** The card's data, from whichever source knows the job: the browser-local
 * job store when this machine ran the render, else the record the render
 * mirrored into the doc (ProjectDoc.renders). */
type RenderView = Pick<GenerateJob, "status" | "prompt" | "startedAt" | "error" | "assetId">;

/** A video render the tool started but couldn't wait out: a live card that
 * follows the generation job and becomes the clip's card when it lands. The
 * job store covers this browser; the doc-mirrored record carries the same
 * card to every other browser and machine. */
export function ChatVideoJobCard({ jobId }: { jobId: string }) {
  const job = useGenerate((s) => s.jobs.find((j) => j.id === jobId));
  const record = useEditor((s) => s.renders.find((r) => r.id === jobId));
  const readOnly = useEditor((s) => s.readOnly);
  // Mount-time clock: a record already past the TTL is stale when the card
  // appears — the check doesn't need to keep ticking.
  const [now] = useState(() => Date.now());
  const view: RenderView | undefined =
    job ??
    (record &&
      (record.status === "running" && now - record.startedAt > RECORD_RUNNING_TTL_MS
        ? { ...record, status: "error" as const, error: "The render was interrupted." }
        : record));
  const elapsed = useElapsed(view?.status === "running" ? view.startedAt : null);
  if (!view) return null;
  if (view.status === "done") return view.assetId ? <ChatProjectAsset assetId={view.assetId} /> : null;
  return (
    <div className="ai-chat-job flex w-full max-w-[280px] flex-col gap-1.5 rounded-xl border border-border p-2.5">
      <div className="flex items-center gap-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          {view.status === "running" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Film className="size-3.5" />
          )}
        </span>
        <div className="min-w-0 flex-1 truncate text-[11px] font-medium">{view.prompt}</div>
      </div>
      <div
        className={cn(
          "text-[10.5px] leading-snug break-words",
          view.status === "error" ? "text-red-600" : "text-muted-foreground"
        )}
      >
        {view.status === "running" ? (
          <>
            Rendering…{" "}
            {elapsed && <span className="tabular-nums text-muted-foreground/80">{elapsed}</span>}
          </>
        ) : (
          <HostedErrorText error={view.error} link={false} />
        )}
      </div>
      {/* Retry needs the job's stored ladder, which lives in this browser's
          job store — a doc-mirrored record from another machine has only the
          prompt, so its card stays informational. */}
      {view.status === "error" && job && !readOnly && (
        <button
          type="button"
          className="self-start text-[10.5px] font-medium underline underline-offset-2 hover:no-underline"
          onClick={() => useGenerate.getState().retry(job.id)}
        >
          Retry
        </button>
      )}
    </div>
  );
}

/** The live ref for a card — the project asset when it exists (fresh name and
 * metadata), the recorded ref otherwise. */
const liveRef = (item: AssetRef, asset?: MediaAsset): AssetRef =>
  asset ? refFromAsset(asset) : item;

const expandRef = (item: AssetRef, asset?: MediaAsset) =>
  useLightbox.getState().open(lightboxItemFromRef(liveRef(item, asset)));

const dragProps = (item: AssetRef, asset?: MediaAsset) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => {
    // Project assets carry the timeline-placement payload; the ref rides along
    // either way so composers and creators accept the drag too.
    if (asset) setAssetDragData(e, asset.id);
    else setRefDragData(e, item);
    // A small cursor chip instead of the full-card snapshot, so dragging a clip
    // onto the timeline doesn't blanket the track it's aiming for.
    setChipDragImage(e);
  },
  onDragEnd: clearAssetDrag,
});

/** The chat card's "…" menu: timeline/expand/reference actions around the
 * shared move-to-Media/Library pair. Project assets only. */
function ChatCardMenu({ asset, triggerClassName }: { asset: MediaAsset; triggerClassName: string }) {
  const projectId = useEditor((s) => s.projectId);
  if (!projectId) return null;
  return (
    <GeneratedAssetMenu
      asset={asset}
      projectId={projectId}
      triggerClassName={triggerClassName}
      before={
        <>
          <DropdownMenuItem
            onClick={() => useEditor.getState().addAssetAtPlayhead(asset.id)}
          >
            <Plus /> Add to timeline
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => expandRef(refFromAsset(asset))}>
            <Maximize2 /> Expand
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              // The session handle (v2, i1) is derived, not stored — resolve
              // it at click time instead of subscribing every card to it.
              const live = projectRefs(useEditor.getState().assets).find(
                (r) => r.id === asset.id
              );
              void navigator.clipboard
                .writeText(refToken(live ?? refFromAsset(asset)))
                .catch(() => {});
            }}
          >
            <Copy /> Copy reference
          </DropdownMenuItem>
        </>
      }
      after={
        <DropdownMenuItem onClick={() => window.open(asset.url, "_blank", "noopener")}>
          <ExternalLink /> Open file
        </DropdownMenuItem>
      }
    />
  );
}

const scrimButton = scrimIconButton;

/** Image / video tile: the preview fills the card at the media's own aspect,
 * sized so portrait and landscape both sit comfortably in the chat column. */
function MediaCard({ item, asset }: ChatCardProps) {
  const { ref: videoRef, handlers: hoverPlay } = useHoverPlay();
  // Chat scrollback holds every card ever made; media loads only once the
  // card actually scrolls into view.
  const [tileRef, seen] = useInView<HTMLDivElement>();
  const ref = liveRef(item, asset);
  const ratio =
    asset?.width && asset?.height ? asset.width / asset.height : item.kind === "image" ? 1 : 16 / 10;
  const width = Math.round(Math.min(248, Math.max(132, 210 * ratio)));
  return (
    <div
      ref={tileRef}
      className="ai-chat-asset group relative shrink-0 cursor-grab overflow-hidden rounded-xl border border-border bg-muted transition-colors hover:border-input"
      style={{ width, aspectRatio: ratio }}
      title={`${ref.name} — double-click to expand · drag to the timeline`}
      {...dragProps(item, asset)}
      onDoubleClick={() => expandRef(item, asset)}
      {...(item.kind === "video" ? hoverPlay : {})}
    >
      {item.kind === "video" ? (
        // Native first frame as the poster — full-resolution, no blurry thumb.
        <video crossOrigin={MEDIA_CORS}
          ref={videoRef}
          src={seen ? `${ref.url}#t=0.1` : undefined}
          preload="metadata"
          muted
          loop
          playsInline
          className="size-full object-cover"
        />
      ) : seen ? (
        // eslint-disable-next-line @next/next/no-img-element -- engine/static file, not Next-optimizable
        <img crossOrigin={MEDIA_CORS} src={ref.url} alt={ref.name} loading="lazy" className="size-full object-cover" />
      ) : null}
      {item.kind === "video" && ref.duration !== undefined && (
        <span className="absolute right-1.5 bottom-1.5 rounded-[5px] bg-black/65 px-1 py-px font-mono text-[9px] text-white tabular-nums">
          {formatTime(ref.duration)}
        </span>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pt-4 pb-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="block truncate text-[10.5px] font-medium text-white">{ref.name}</span>
      </div>
      <div className="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 has-data-popup-open:opacity-100">
        <button title="Expand" className={scrimButton} onClick={() => expandRef(item, asset)}>
          <Maximize2 className="size-3" />
        </button>
        {asset && <ChatCardMenu asset={asset} triggerClassName={scrimButton} />}
      </div>
    </div>
  );
}

/** Audio as the shared playable row (waveform, play, drag), with the chat menu
 * on it; double-click opens the big player. Playback goes through the
 * app-wide preview player, so it stops other previews and vice versa. */
function AudioCard({ item, asset }: ChatCardProps) {
  const ref = liveRef(item, asset);
  const playing = usePreviewAudio((s) => s.url === ref.url);
  // Only this card's own preview stops when the card goes away.
  useEffect(() => {
    const url = ref.url;
    return () => usePreviewAudio.getState().stop(url);
  }, [ref.url]);
  return (
    <div className="ai-chat-asset w-full" onDoubleClick={() => expandRef(item, asset)}>
      <AudioRow
        name={ref.name}
        duration={ref.duration ?? 0}
        url={ref.url}
        peaks={asset?.peaks}
        playing={playing}
        onTogglePlay={(url) => usePreviewAudio.getState().toggle(url)}
        onAdd={() => asset && useEditor.getState().addAssetAtPlayhead(asset.id)}
        menu={asset && <ChatCardMenu asset={asset} triggerClassName={scrimIconButton} />}
        onDragStart={(e) => {
          if (asset) setAssetDragData(e, asset.id);
          else setRefDragData(e, item);
        }}
      />
    </div>
  );
}

/** How much of a text file the card shows before the fade; the lightbox
 * renders the whole thing. */
const DOC_PREVIEW_CHARS = 1200;

/** A text file (markdown, CSV, plain) as a clipped document card. */
function DocCard({ item, asset }: ChatCardProps) {
  const { text, failed } = useDocText(item.url);
  const clipped = text !== null && text.length > DOC_PREVIEW_CHARS;
  return (
    <div
      className="ai-chat-asset group relative w-full max-w-[280px] cursor-default overflow-hidden rounded-xl border border-border bg-background transition-colors hover:border-input"
      title={`${item.name} — double-click to expand`}
      {...dragProps(item, asset)}
      onDoubleClick={() => expandRef(item, asset)}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{item.name}</span>
        <button
          title="Expand"
          className={cn(scrimButton, "opacity-0 transition-opacity group-hover:opacity-100")}
          onClick={() => expandRef(item, asset)}
        >
          <Maximize2 className="size-3" />
        </button>
      </div>
      <div className="relative max-h-44 overflow-hidden px-2.5 py-2 text-[11px] leading-relaxed">
        {failed ? (
          <p className="text-muted-foreground">Could not read the file.</p>
        ) : text === null ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : (
          <DocText name={item.name} text={clipped ? text.slice(0, DOC_PREVIEW_CHARS) : text} />
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent" />
      </div>
    </div>
  );
}
