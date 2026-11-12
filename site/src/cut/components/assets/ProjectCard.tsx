"use client";

import { useEffect, useState, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { Cloud, Copy, Film, Laptop, LayoutTemplate, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { capturePosterWhenReady, readPoster } from "@/cut/lib/posterCache";
import { backendFor, type Residency } from "@/cut/lib/queries";
import { useHoverPlay } from "@/cut/hooks/useHoverPlay";
import { useInView } from "@/cut/hooks/useInView";
import { localMediaUrl } from "@/cut/lib/mediaSync";
import { PICKED_RING } from "@/cut/lib/assetPick";
import { formatTime } from "@/cut/lib/time";
import type { ProjectSummary } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

// The badge marks where one project lives, so it says that outright rather
// than repeating the shelf heading it sits under. A local project the Donkey
// app isn't answering for says that instead: it is the reason its card can't
// be renamed or moved.
const RESIDENCY_HINT = {
  local: "badgeLocal",
  cloud: "badgeCloud",
  browser: "badgeLocal",
} as const satisfies Record<Residency, string>;

export function ResidencyBadge({
  residency,
  offline = false,
  className,
}: {
  residency: Residency;
  offline?: boolean;
  className?: string;
}) {
  const t = useTranslations("home.projects");
  const Icon = residency === "cloud" ? Cloud : Laptop;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span />} className={className}>
          <Icon className="size-3" />
        </TooltipTrigger>
        <TooltipContent>{offline ? t("badgeOffline") : t(RESIDENCY_HINT[residency])}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// A card's picture fills it with 1% to spare: a 9:16 frame covers the card at
// a fractional width, and a playing video's layer can draw that edge as a
// dark seam inside the rounded clip.
const COVER = "size-full scale-[1.01] object-cover";

/** Card art: the actual edit (a rendered proxy) plays on hover; the poster is
 * the first clip's real first frame. Falls back to the source when no proxy
 * has been rendered yet.
 *
 * The source is withheld until the tile has been scrolled near, because each
 * card is a real media element: a grid of cloud projects would otherwise open
 * a connection per card on arrival and pull every file's metadata across the
 * network before the first row settled. A shelf that isn't answering has no
 * media to reach at all, so those cards stop at the frame they cached. */
export function CardPreview({
  project: p,
  residency,
  offline = false,
}: {
  project: ProjectSummary;
  residency: Residency;
  offline?: boolean;
}) {
  // The proxy starts at the edit's first frame; the source starts at the clip's
  // trim-in, so both posters show what actually plays first.
  const posterT = p.hasPreview ? 0 : p.previewStart ?? 0.1;
  const { ref: videoRef, handlers: hoverPlay } = useHoverPlay(posterT, "silent");
  const [tileRef, seen] = useInView<HTMLDivElement>();
  // The frame this card drew last time, so coming back from a project shows the
  // picture at once instead of a grey rectangle while the media loads.
  const poster = useCardPoster(p.id, residency, videoRef, seen);
  // Whether the media itself has a frame up yet. Until it does the cached one
  // is what the tile shows — as its own layer, because the element's `poster`
  // attribute is read when the media starts loading and the cached frame comes
  // out of IndexedDB a moment after that.
  const [decoded, setDecoded] = useState(false);
  const backend = backendFor(residency);
  // A browser-resident card's media lives in the OPFS store, and blob URLs
  // are session-scoped: a fresh tab holds none until this mints one. Until it
  // resolves the card shows its cached poster, like an offline shelf.
  const [storeUrl, setStoreUrl] = useState<string | null>(null);
  const previewFile = p.previewFile;
  useEffect(() => {
    if (residency !== "browser" || !previewFile) return;
    let alive = true;
    void localMediaUrl(p.id, previewFile).then((u) => {
      if (alive && u) setStoreUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [residency, p.id, previewFile]);
  const fileUrl = (file: string) =>
    residency === "browser"
      ? (storeUrl ?? "")
      : backend.url(`/api/cut/projects/${p.id}/media/${encodeURIComponent(file)}`);

  if (offline) {
    return poster ? (
      // eslint-disable-next-line @next/next/no-img-element -- a cached data URL, not a Next asset
      <img
        src={poster}
        alt=""
        draggable={false}
        className={cn("absolute inset-0", COVER)}
      />
    ) : (
      <Film className="size-7 text-muted-foreground/50" />
    );
  }

  if (!p.previewFile && !p.hasPreview) {
    return (
      <Film className="size-7 text-muted-foreground/50 transition-transform group-hover:scale-110" />
    );
  }

  if (residency === "browser" && !storeUrl) {
    return poster ? (
      // eslint-disable-next-line @next/next/no-img-element -- a cached data URL, not a Next asset
      <img
        src={poster}
        alt=""
        draggable={false}
        className={cn("absolute inset-0", COVER)}
      />
    ) : (
      <Film className="size-7 text-muted-foreground/50" />
    );
  }

  // A still-image project with no rendered proxy posters as the image itself.
  if (!p.hasPreview && p.previewIsImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- engine media file, not Next-optimizable
      <img
        crossOrigin={MEDIA_CORS}
        src={fileUrl(p.previewFile!)}
        alt=""
        loading="lazy"
        className={cn("absolute inset-0", COVER)}
      />
    );
  }

  const src = p.hasPreview
    ? backend.url(`/api/cut/projects/${p.id}/preview`)
    : fileUrl(p.previewFile!);

  return (
    <div
      ref={tileRef}
      className="absolute inset-0"
      {...hoverPlay}
    >
      {seen && (
        <video
          crossOrigin={MEDIA_CORS}
          ref={videoRef}
          src={`${src}#t=${posterT}`}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedData={() => setDecoded(true)}
          className={COVER}
        />
      )}
      {poster && !decoded && (
        // eslint-disable-next-line @next/next/no-img-element -- a cached data URL, not a Next asset
        <img
          src={poster}
          alt=""
          draggable={false}
          className={cn("absolute inset-0", COVER)}
        />
      )}
    </div>
  );
}

/** The cached opening frame for a project card, once it has been read off this
 * machine, and the standing job of keeping it fresh. Null until the read lands,
 * and for a project this browser has never drawn. */
function useCardPoster(
  projectId: string,
  residency: Residency,
  videoRef: RefObject<HTMLVideoElement | null>,
  seen: boolean
): string | null {
  const [poster, setPoster] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void readPoster("card", projectId, residency).then((data) => {
      if (alive) setPoster(data);
    });
    return () => {
      alive = false;
    };
  }, [projectId, residency]);
  useEffect(() => {
    if (!seen) return;
    return capturePosterWhenReady("card", projectId, () => videoRef.current, residency);
  }, [projectId, residency, seen, videoRef]);
  return poster;
}

const MOVE_DEST = {
  local: { Icon: Laptop, label: "moveToLocal" },
  cloud: { Icon: Cloud, label: "moveToCloud" },
  browser: { Icon: Laptop, label: "moveToLocal" },
} as const satisfies Record<Residency, { Icon: typeof Cloud; label: string }>;

/** The actions on a project, or on a set of them: Rename and Duplicate take
 * one project, so a set offers only the moves every member can make and
 * Delete. */
export function ProjectMenuItems({
  onRename,
  onDuplicate,
  onMakeTemplate,
  moveTo,
  onDelete,
}: {
  onRename?: () => void;
  onDuplicate?: () => void;
  onMakeTemplate?: () => void;
  /** The other live residencies this project can move to. */
  moveTo?: { target: Residency; run: () => void }[];
  onDelete: () => void;
}) {
  const t = useTranslations("home.projects");
  return (
    <>
      {onRename && (
        <DropdownMenuItem onClick={onRename}>
          <Pencil /> {t("rename")}
        </DropdownMenuItem>
      )}
      {onDuplicate && (
        <DropdownMenuItem onClick={onDuplicate}>
          <Copy /> {t("duplicate")}
        </DropdownMenuItem>
      )}
      {onMakeTemplate && (
        <DropdownMenuItem onClick={onMakeTemplate}>
          <LayoutTemplate /> {t("makeTemplate")}
        </DropdownMenuItem>
      )}
      {moveTo?.map(({ target, run }) => {
        const { Icon, label } = MOVE_DEST[target];
        return (
          <DropdownMenuItem key={target} onClick={run}>
            <Icon /> {t(label)}
          </DropdownMenuItem>
        );
      })}
      {(onRename || onDuplicate || onMakeTemplate || (moveTo?.length ?? 0) > 0) && <DropdownMenuSeparator />}
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <Trash2 /> {t("delete")}
      </DropdownMenuItem>
    </>
  );
}

export function ProjectMenu({
  className,
  onRename,
  onDuplicate,
  onMakeTemplate,
  moveTo,
  onDelete,
}: {
  className?: string;
  onRename: () => void;
  onDuplicate: () => void;
  onMakeTemplate: () => void;
  /** The other live residencies this project can move to. */
  moveTo?: { target: Residency; run: () => void }[];
  onDelete: () => void;
}) {
  const t = useTranslations("home.projects");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("actions")}
            className={cn("bg-black/40 text-white hover:bg-black/60 hover:text-white", className)}
            onClick={(e) => e.stopPropagation()}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <ProjectMenuItems
          onRename={onRename}
          onDuplicate={onDuplicate}
          onMakeTemplate={onMakeTemplate}
          moveTo={moveTo}
          onDelete={onDelete}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One project card: the edit's picture with its name pill, where it lives,
 * and its length, then size and last edit below. The box comes from the
 * caller so a grid can give every card the same long side.
 */
export function ProjectTile({
  project: p,
  residency,
  offline,
  badge,
  selected,
  box,
  meta,
  menu,
  className,
  ...handlers
}: {
  project: ProjectSummary;
  residency: Residency;
  offline: boolean;
  /** Whether the card says where it lives: only when more than one place lists. */
  badge: "residency" | "none";
  selected: boolean;
  box: { width: number; height: number };
  /** The line under the card: size and last edit. */
  meta: string;
  /** The ⋯ menu, for a shelf that takes changes. */
  menu?: React.ReactNode;
  className?: string;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  onAuxClick?: (e: React.MouseEvent) => void;
}) {
  return (
    <div data-sel-id={p.id} className={cn("group max-w-full cursor-pointer", className)} {...handlers}>
      <div
        className={cn(
          "relative grid place-items-center overflow-hidden rounded-2xl border bg-muted transition-shadow group-hover:shadow-[0_6px_28px_rgba(0,0,0,0.12)]",
          selected ? PICKED_RING : "border-border",
        )}
        style={{ width: box.width, height: box.height }}
      >
        <CardPreview project={p} residency={residency} offline={offline} />
        <span className="absolute top-2 left-2 max-w-[70%] truncate rounded-lg bg-black/55 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
          {p.name}
        </span>
        {badge === "residency" && (
          <ResidencyBadge
            residency={residency}
            offline={offline}
            className="absolute bottom-2 left-2 z-10 grid size-5 place-items-center rounded-md bg-black/65 text-white"
          />
        )}
        <span className="absolute right-2 bottom-2 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[10px] text-white tabular-nums">
          {formatTime(p.duration)}
        </span>
        {menu}
      </div>
      <div className="mt-2 truncate px-0.5 text-xs text-muted-foreground" style={{ maxWidth: box.width }}>
        {meta}
      </div>
    </div>
  );
}
