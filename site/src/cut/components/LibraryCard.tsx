"use client";

import { useState, type ReactNode } from "react";
import { useEnvironment } from "@/cut/lib/environment";
import { Download, Ellipsis, ExternalLink, Film, Image as ImageIcon, Music, Plus, Share2, Trash2, Type } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { MediaCardShell } from "@/cut/components/MediaCardShell";
import { ShelfBadge } from "@/cut/components/ShelfBadge";
import { AudioCardFace } from "@/cut/components/AudioPanel";
import { CopyNameLabel } from "@/cut/components/AssetRefs";
import { FontSpecimen } from "@/cut/components/FontSpecimen";
import { useInView } from "@/cut/hooks/useInView";
import { useMediaFileSize } from "@/cut/hooks/useMediaFileSize";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { setLibraryDragData } from "@/cut/lib/assetDrag";
import { refFromLibrary } from "@/cut/lib/assetRef";
import { fileKind } from "@/cut/lib/media";
import { libraryMediaUrl, libraryPosterUrl, downloadLibraryAsset, type LibraryAsset } from "@/cut/lib/library";
import { lightboxItemFromLibrary, type LightboxItem } from "@/cut/lib/lightbox";
import { availableResidencies } from "@/cut/lib/residency";
import { SPECIMEN_BG, SPECIMEN_INK, SPECIMEN_META } from "@/cut/lib/fontSpecimen";
import { PICKED_RING } from "@/cut/lib/assetPick";
import { formatTime } from "@/cut/lib/time";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/utils";

export const LIBRARY_TILE_AREA = 180 * 320;
export const LIBRARY_AUDIO_TILE_AREA = LIBRARY_TILE_AREA * 0.7 ** 2;

type SharedMedia = { src: string; poster?: string; downloadHref: string };

/** The library media card, with protected media URLs supplied by a share viewer. */
export function LibraryCard({
  asset: a,
  sharedMedia,
  selected,
  offline = false,
  area,
  mention = false,
  caption,
  dragGroup,
  onClick,
  onDelete,
  onUse,
  onShare,
  onDragStartExtra,
}: {
  asset: LibraryAsset;
  sharedMedia?: SharedMedia;
  selected?: boolean;
  /** The shelf this item is on isn't answering: it lists from memory, so the
   * card shows what it knows and reaches for no media it can't load. */
  offline?: boolean;
  /** Tile area in square pixels. When set, the tile takes the media's own
   * aspect at this shared area — a wide clip spreads, a tall one stands, and
   * every card carries the same weight. Unset, the tile fills its grid cell
   * as a square. Audio and unmeasured assets sit square either way. */
  area?: number;
  /** The card sits beside a prompt (the editor's Library panel), so its name
   * doubles as a mention token to copy. */
  mention?: boolean;
  /** A line under the tile — where the Camera Roll puts a recording's date. */
  caption?: ReactNode;
  /** Everything picked on this shelf right now. Dragging a card that is one of
   * them carries the whole set, so a drop lands the lot. */
  dragGroup?: LibraryAsset[];
  onClick?: (e: React.MouseEvent) => void;
  onDelete?: () => void;
  onUse?: () => void;
  onShare?: () => void;
  onDragStartExtra?: (e: React.DragEvent) => void;
}) {
  const { chatgpt } = useEnvironment();
  // ⌘C over the card copies its mention token. A card inside the current
  // selection carries the whole set, the same rule its drag follows. A font is
  // used from the font menu, so it names nothing a prompt can point a tool
  // at.
  const refs = () => sharedMedia ? [] :
    (selected && dragGroup?.length ? dragGroup : [a])
      .filter((x) => x.type !== "font")
      .map(refFromLibrary);
  // With one shelf listed, every card is on it — the badge would say nothing.
  // Phone recordings all come up from the cloud, so they carry none either.
  const bothShelves =
    !sharedMedia && a.origin !== "camera" && (availableResidencies().length > 1 || offline);
  // Each card is a real media element, so the source waits until the tile has
  // been scrolled near: a large library would otherwise pull every file's
  // metadata across the network the moment the page opened.
  const [tileRef, seen] = useInView<HTMLDivElement>();
  const src = sharedMedia?.src ?? libraryMediaUrl(a.fileName, a.residency);
  const poster = sharedMedia ? sharedMedia.poster : libraryPosterUrl(a);
  const view = (): LightboxItem => sharedMedia ? {
    kind: a.type, src, name: a.title || a.name, prompt: "", assetId: null, bare: true,
    duration: a.duration, poster, ...(a.width && a.height ? { ratio: a.width / a.height } : {}),
  } : lightboxItemFromLibrary(a, !onUse);

  // Poster from the video itself so the still matches what plays on hover.
  // An ffmpeg still washes out iPhone HDR (HLG) footage — the browser tone-maps
  // the video correctly, so we render the frame instead of a baked thumbnail.
  const posterT = Math.min(1, Math.max(0.1, (a.duration || 2) / 10));
  // Whether the tile's own picture has painted. Until it does the tile is a
  // shimmering slab, so a clip that lands while the page is open takes its
  // place in the grid at once and resolves into itself a moment later.
  const [painted, setPainted] = useState(false);
  // The size pill only shows on hover, so the lookup waits for the first one.
  // A font wears its size in the footer at rest, so that one asks as it scrolls
  // into view.
  const [hovered, setHovered] = useState(false);
  const font = a.type === "font";
  const sizeBytes = useMediaFileSize(
    offline ? "" : src,
    hovered || (font && seen),
  );
  // TTF · 42 KB — what the file is, and how much of it there is.
  const fontMeta = [
    fileKind(a.fileName),
    sizeBytes != null && formatBytes(sizeBytes),
  ]
    .filter(Boolean)
    .join(" · ");
  const frame =
    area && a.type !== "audio" && a.width && a.height
      ? { w: a.width, h: a.height }
      : font
        ? { w: 16, h: 6 }
        : { w: 1, h: 1 };
  const tileStyle = {
    ...(area
      ? {
          width: Math.round(Math.sqrt((area * frame.w) / frame.h)),
          aspectRatio: `${frame.w} / ${frame.h}`,
        }
      : {}),
    ...(font ? { backgroundColor: SPECIMEN_BG, color: SPECIMEN_INK } : {}),
  };

  return (
    <MediaCardShell
      scope="library"
      id={a.id}
      refs={refs}
      // Without a + button there is no project to add it to, so the viewer
      // opens bare.
      view={offline ? undefined : view}
      restTime={posterT}
      draggable={!offline && !sharedMedia}
      className="group flex min-w-0 max-w-full flex-col"
      onClick={onClick}
      onDragStart={(e) => {
        if (sharedMedia) return;
        setLibraryDragData(e, a, dragGroup);
        onDragStartExtra?.(e);
      }}
      onHover={() => setHovered(true)}
    >
      {({ flash, videoRef }) => (
        <>
          <div
            ref={tileRef}
            data-drag-object
            className={cn(
              "relative max-w-full cursor-grab overflow-hidden rounded-xl border bg-muted transition-shadow group-hover:shadow-[0_4px_20px_rgba(0,0,0,0.1)] active:cursor-grabbing",
              !area && (font ? "aspect-[16/7]" : "aspect-square"),
              // The sheet is the card, so nothing is drawn around it; the type
              // scales with the tile, which runs from a panel column to a full row.
              font && "@container flex flex-col",
              selected || flash
                ? PICKED_RING
                : font
                  ? "border-transparent"
                  : "border-border",
            )}
            style={tileStyle}
          >
            {font ? (
              // A pangram set in the face, and under a hairline the name it goes by
              // with the file behind it. Nothing to load from a shelf that isn't
              // answering, so that card shows the kind mark instead.
              <div className="flex size-full min-h-0 flex-col">
                <div className="grid min-h-0 flex-1 place-items-center px-3 pt-3 @[220px]:px-5 @[220px]:pt-5">
                  {offline ? (
                    <Type className="size-6 text-white/35" />
                  ) : (
                    <FontSpecimen
                      assetId={a.id}
                      src={sharedMedia && seen ? src : undefined}
                      fitHeight
                      pad={0}
                      className="size-full"
                    />
                  )}
                </div>
                <div className="mx-3 flex items-center justify-between gap-2 border-t border-white/10 py-2 @[220px]:mx-5 @[220px]:py-3">
                  <CopyNameLabel
                    name={a.name}
                    label={a.title}
                    dark
                    mention={false}
                    className="min-w-0 text-[11px] font-medium @[220px]:text-[13px]"
                  />
                  {fontMeta && (
                    <span
                      data-drag-omit
                      className="shrink-0 text-[10px] tabular-nums @[220px]:text-[11px]"
                      style={{ color: SPECIMEN_META }}
                    >
                      {fontMeta}
                    </span>
                  )}
                </div>
              </div>
            ) : offline ? (
              // Nothing to load from a shelf that isn't answering, so the card
              // shows what it knows: the kind of file, its name, its length.
              <span className="grid size-full place-items-center">
                {a.type === "audio" ? (
                  <Music className="size-6 text-muted-foreground/50" />
                ) : a.type === "image" ? (
                  <ImageIcon className="size-6 text-muted-foreground/50" />
                ) : (
                  <Film className="size-6 text-muted-foreground/50" />
                )}
              </span>
            ) : a.type === "video" ? (
              seen && (
                <>
                  <video
                    crossOrigin={MEDIA_CORS}
                    ref={videoRef}
                    src={`${src}#t=${posterT}`}
                    poster={poster}
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    className="size-full object-cover"
                    // Whichever lands first: a clip with a stored poster paints
                    // from that, one without paints its own first frame.
                    onLoadedMetadata={() => setPainted(true)}
                    onLoadedData={() => setPainted(true)}
                    onError={() => setPainted(true)}
                  />
                  {/* The source's own cover — a video's thumbnail where it came
                      from — is the face at rest: the element's poster gives way as
                      soon as the browser has the frame at #t, and that frame is
                      whatever the clip happens to hold a second in. Hovering
                      uncovers the video, which is what plays. */}
                  {poster && (
                    // eslint-disable-next-line @next/next/no-img-element -- library media file, not Next-optimizable
                    <img
                      crossOrigin={MEDIA_CORS}
                      src={poster}
                      alt=""
                      aria-hidden
                      className="pointer-events-none absolute inset-0 size-full object-cover transition-opacity group-hover:opacity-0"
                      onLoad={() => setPainted(true)}
                      onError={() => setPainted(true)}
                    />
                  )}
                </>
              )
            ) : a.type === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element -- library media file, not Next-optimizable
              <img
                crossOrigin={MEDIA_CORS}
                src={src}
                alt={a.name}
                loading="lazy"
                className="size-full object-cover"
                onLoad={() => setPainted(true)}
                onError={() => setPainted(true)}
              />
            ) : (
              <AudioCardFace
                url={src}
                duration={a.duration}
                // On hover the + button takes the pill's corner.
                durationClassName={
                  !!onUse && "transition-opacity group-hover:opacity-0"
                }
              />
            )}
            {!offline && !font && a.type !== "audio" && !painted && (
              <Skeleton
                data-drag-omit
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-none"
              />
            )}
            {a.type !== "audio" &&
              !font &&
              (a.type === "video" || sizeBytes != null) && (
                // Length and size share one pill in the corner: on a card this narrow
                // two of them collide. The length reads at rest, the size takes over
                // on hover, where the + button is what the pointer is there for.
                <span
                  data-drag-omit
                  className={cn(
                    "absolute right-1.5 bottom-1.5 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[10px] text-white tabular-nums",
                    a.type !== "video" &&
                      "opacity-0 transition-opacity group-hover:opacity-100",
                  )}
                >
                  {a.type === "video" && (
                    <span className={cn(sizeBytes != null && "group-hover:hidden")}>
                      {formatTime(a.duration)}
                    </span>
                  )}
                  {sizeBytes != null && (
                    <span
                      className={cn(
                        a.type === "video" && "hidden group-hover:inline",
                      )}
                    >
                      {formatBytes(sizeBytes)}
                    </span>
                  )}
                </span>
              )}
            {a.type === "audio" && sizeBytes != null && (
              // Clear of the play circle, matching the face's duration pill.
              <span className="absolute bottom-3 left-12 rounded-md bg-[#2b4e42] px-1.5 py-0.5 font-mono text-[10px] text-[#d6eddf] tabular-nums opacity-0 transition-opacity group-hover:opacity-100">
                {formatBytes(sizeBytes)}
              </span>
            )}
            {onUse && (
              <button
                aria-label="Add to timeline"
                title="Add to timeline"
                className={cn(
                  "absolute grid size-6 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow transition-all group-hover:opacity-100 hover:scale-110",
                  // Audio keeps play bottom-left; + swaps in where the badge hides.
                  // A font's bottom edge is its footer, so its + takes the corner
                  // the name used to sit in.
                  a.type === "audio"
                    ? "right-1.5 bottom-1.5"
                    : font
                      ? "top-1.5 left-1.5"
                      : "bottom-1.5 left-1.5",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onUse();
                }}
              >
                <Plus className="size-3.5" />
              </button>
            )}
            {bothShelves && (
              <ShelfBadge
                residency={a.residency}
                offline={offline}
                className={cn(
                  "absolute top-2 right-2 transition-opacity",
                  offline ? "text-muted-foreground" : "text-white/85",
                  // The actions menu takes this corner on hover.
                  "group-hover:opacity-0",
                )}
              />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="More actions"
                title="More actions"
                className={cn(
                  "absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full text-white opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100",
                  // A black scrim disappears into the charcoal sheet.
                  font
                    ? "bg-white/10 hover:bg-white/20"
                    : "bg-black/40 hover:bg-black/60",
                )}
                onClick={(e) => e.stopPropagation()}
              >
                <Ellipsis className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                // Hung off the card's right edge rather than laid over the media:
                // the tile stays readable behind the open menu.
                align="start"
                alignOffset={4}
                className="w-44"
                onClick={(e) => e.stopPropagation()}
              >
                {onShare && <DropdownMenuItem disabled={offline} onClick={onShare}><Share2 /> Share</DropdownMenuItem>}
                {chatgpt ? null : sharedMedia ? (
                  <DropdownMenuItem render={<a href={sharedMedia.downloadHref} />}>
                    <Download /> Download
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => downloadLibraryAsset(a)} disabled={offline}>
                    <Download /> Download
                  </DropdownMenuItem>
                )}
                {a.source?.url && (
                  // An imported clip keeps the link it came from, so the post it was
                  // cut out of is one click away.
                  <DropdownMenuItem
                    onClick={() =>
                      window.open(a.source!.url, "_blank", "noopener,noreferrer")
                    }
                  >
                    <ExternalLink /> Open original
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={onDelete}>
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {!font && (
              <CopyNameLabel
                name={a.name}
                label={a.title}
                dark={a.type === "audio"}
                mention={mention}
                className={cn(
                  "absolute top-1.5 left-1.5 max-w-[70%] px-2 py-1 text-[11px] font-medium text-white transition-[max-width] group-hover:max-w-[calc(100%-2.75rem)]",
                  // The emerald fill is its own backdrop; thumbnails need the scrim pill.
                  a.type !== "audio" && "rounded-lg bg-black/55 backdrop-blur-sm",
                )}
              />
            )}
          </div>
          {caption && (
            <div data-drag-omit className="mt-2 px-0.5 text-xs text-muted-foreground">
              {caption}
            </div>
          )}
        </>
      )}
    </MediaCardShell>
  );
}
