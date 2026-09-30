"use client";

import { useState, type ReactNode } from "react";
import { isLinkedAssetType, type AssetType } from "@/cut/lib/types";
import { Film, Image as ImageIcon, Music, Type } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { CardActionsMenu } from "@/cut/components/CardActionsMenu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MediaCardShell } from "@/cut/components/MediaCardShell";
import { RenameInput } from "@/cut/components/RenameInput";
import { ShelfBadge } from "@/cut/components/ShelfBadge";
import { AudioCardFace } from "@/cut/components/AudioPanel";
import { CopyNameLabel } from "@/cut/components/AssetRefs";
import { FontSpecimen } from "@/cut/components/FontSpecimen";
import { useInView } from "@/cut/hooks/useInView";
import { useMediaFileSize } from "@/cut/hooks/useMediaFileSize";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { setLibraryDragData } from "@/cut/lib/assetDrag";
import { refFromLibrary } from "@/cut/lib/assetRef";
import { openExternal } from "@/cut/lib/hostBridge";
import { fileKind } from "@/cut/lib/media";
import { libraryAssetName, libraryMediaUrl, libraryPosterUrl, downloadLibraryAsset, type LibraryAsset } from "@/cut/lib/library";
import { LUT_FILE_ICON, LUT_MARK_ICON } from "@/cut/lib/linkedLibrary";
import { lightboxItemFromLibrary, type LightboxItem } from "@/cut/lib/lightbox";
import { availableResidencies } from "@/cut/lib/residency";
import { SPECIMEN_BG, SPECIMEN_INK, SPECIMEN_META } from "@/cut/lib/fontSpecimen";
import { PICKED_RING } from "@/cut/lib/assetPick";
import { formatElapsed } from "@/cut/lib/time";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/utils";

export const LIBRARY_TILE_AREA = 180 * 320;
export const LIBRARY_AUDIO_TILE_AREA = LIBRARY_TILE_AREA * 0.7 ** 2;
/** The side of the square every Library file other than a picture takes:
 * sounds, LUTs, fonts, notes and templates. */
export const LIBRARY_SQUARE = Math.round(Math.sqrt(LIBRARY_AUDIO_TILE_AREA));

type SharedMedia = { src: string; poster?: string; downloadHref: string };

/** A Library tile's box. Pictures take their own aspect at the shared area;
 * every other file is the square the sound tile is. Without an area the tile
 * fills its grid cell. An arriving file draws the same box its asset will. */
export function libraryTileBox(
  type: AssetType | undefined,
  shape: { width?: number; height?: number } | undefined,
  area: number | undefined,
) {
  const font = type === "font";
  const frame =
    area && (type === "video" || type === "image") && shape?.width && shape.height
      ? { w: shape.width, h: shape.height }
      : { w: 1, h: 1 };
  return {
    className: cn(
      "relative max-w-full overflow-hidden rounded-xl border shadow-sm",
      type === "lut" ? "bg-background" : "bg-muted",
      !area && (font ? "aspect-[16/7]" : "aspect-square"),
      // The sheet is the card, so nothing is drawn around it; the type
      // scales with the tile, which runs from a panel column to a full row.
      font && "@container flex flex-col",
    ),
    style: {
      ...(area
        ? {
            width: Math.round(Math.sqrt((area * frame.w) / frame.h)),
            aspectRatio: `${frame.w} / ${frame.h}`,
          }
        : {}),
      ...(font ? { backgroundColor: SPECIMEN_BG, color: SPECIMEN_INK } : {}),
    },
  };
}

/** The name in a tile's top-left corner. */
export const libraryNameClass = (type: AssetType | undefined) =>
  cn(
    "absolute top-1.5 left-1.5 max-w-[70%] px-2 py-1 text-[11px] font-medium text-white transition-[max-width] group-hover:max-w-[calc(100%-2.75rem)]",
    // The emerald fill is its own backdrop; thumbnails need the scrim pill.
    type !== "audio" && type !== "lut" && "rounded-lg bg-black/55 backdrop-blur-sm",
    type === "lut" && "text-foreground",
  );

/** A LUT's face: the cube with its LUT wordmark under the name, the way a
 * sound tile sets its own. */
export function LibraryLutFace() {
  // eslint-disable-next-line @next/next/no-img-element -- static icon
  return <img src={LUT_FILE_ICON} alt="" aria-hidden className="size-full object-contain px-2 pt-8 pb-2" />;
}

/** A font's face: a pangram set in the face, and under a hairline the name it
 * goes by with the file behind it. */
export function LibraryFontFace({
  specimen,
  name,
  label,
  meta,
  nameEdit,
}: {
  specimen: ReactNode;
  name: string;
  label?: string;
  meta?: string;
  /** The rename field, in the name's place while it is open. */
  nameEdit?: ReactNode;
}) {
  return (
    <div className="flex size-full min-h-0 flex-col">
      <div className="grid min-h-0 flex-1 place-items-center px-3 pt-3 @[220px]:px-5 @[220px]:pt-5">
        {specimen}
      </div>
      <div className="mx-3 flex items-center justify-between gap-2 border-t border-white/10 py-2 @[220px]:mx-5 @[220px]:py-3">
        {nameEdit ?? (
          <CopyNameLabel
            name={name}
            label={label}
            dark
            mention={false}
            className="min-w-0 text-[11px] font-medium @[220px]:text-[13px]"
          />
        )}
        {meta && !nameEdit && (
          <span
            data-drag-omit
            className="shrink-0 text-[10px] tabular-nums @[220px]:text-[11px]"
            style={{ color: SPECIMEN_META }}
          >
            {meta}
          </span>
        )}
      </div>
    </div>
  );
}

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
  onRename,
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
  /** A refusal shows on the card with its reason. */
  onRename?: (name: string) => Promise<unknown>;
  onDragStartExtra?: (e: React.DragEvent) => void;
}) {
  // ⌘C over the card copies its mention token. A card inside the current
  // selection carries the whole set, the same rule its drag follows. A font is
  // used from the font menu, so it names nothing a prompt can point a tool
  // at.
  const refs = () => sharedMedia ? [] :
    (selected && dragGroup?.length ? dragGroup : [a])
      .filter((x) => !isLinkedAssetType(x.type))
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
    kind: a.type, src, name: libraryAssetName(a), prompt: "", assetId: null, bare: true,
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
  // A LUT tile is the file icon; its facts (CUBE · 33³) ride the footer.
  const lut = a.type === "lut";
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
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string>();
  const nameEdit = renaming && (
    <RenameInput
      value={libraryAssetName(a)}
      className={cn(font ? "text-foreground" : "absolute top-1.5 right-1.5 left-1.5 w-auto bg-background")}
      onDone={(name) => {
        setRenaming(false);
        if (!name || !onRename) return;
        setRenameError(undefined);
        onRename(name).catch((e: unknown) => {
          setRenameError(e instanceof Error ? e.message : "Could not rename the file.");
          setTimeout(() => setRenameError(undefined), 6000);
        });
      }}
    />
  );
  const box = libraryTileBox(a.type, a, area);

  return (
    <MediaCardShell
      scope="library"
      id={a.id}
      refs={refs}
      // Without an "Add to timeline" item there is no project to add it to, so the viewer
      // opens bare.
      view={offline ? undefined : view}
      restTime={posterT}
      draggable={!offline && !sharedMedia && !renaming}
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
            data-drag-ghost={lut ? LUT_MARK_ICON : undefined}
            className={cn(
              box.className,
              "cursor-grab transition-shadow active:cursor-grabbing",
              !lut && "group-hover:shadow-[0_4px_20px_rgba(0,0,0,0.1)]",
              selected || flash
                ? PICKED_RING
                : font
                  ? "border-transparent"
                  : "border-border",
            )}
            style={box.style}
          >
            {font ? (
              // Nothing to load from a shelf that isn't answering, so that card
              // shows the kind mark in place of the specimen.
              <LibraryFontFace
                name={a.name}
                label={a.title}
                meta={fontMeta}
                nameEdit={nameEdit || undefined}
                specimen={
                  offline ? (
                    <Type className="size-6 text-white/35" />
                  ) : (
                    <FontSpecimen
                      assetId={a.id}
                      src={seen ? src : undefined}
                      pad={0}
                      className="size-full"
                    />
                  )
                }
              />
            ) : lut ? (
              <LibraryLutFace />
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
              <AudioCardFace url={src} duration={a.duration} />
            )}
            {!offline && !font && !lut && a.type !== "audio" && !painted && (
              <Skeleton
                data-drag-omit
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-none"
              />
            )}
            {a.type !== "audio" &&
              !font &&
              !lut &&
              (a.type === "video" || sizeBytes != null) && (
                // Length and size share one pill in the corner: on a card this narrow
                // two of them collide. The length reads at rest, the size takes over
                // on hover.
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
                      {formatElapsed(a.duration * 1000)}
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
            <CardActionsMenu
              sheet={font}
              className="absolute top-1.5 right-1.5"
              onUse={onUse}
              onShare={onShare}
              shareDisabled={offline}
              onRename={onRename && !offline ? () => setRenaming(true) : undefined}
              downloadHref={sharedMedia?.downloadHref}
              onDownload={sharedMedia ? undefined : () => downloadLibraryAsset(a)}
              downloadDisabled={offline}
              onOpenOriginal={a.source?.url ? () => openExternal(a.source!.url) : undefined}
              onDelete={onDelete}
            />
            {renameError && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        data-drag-omit
                        className="absolute bottom-1.5 left-1.5 rounded-md bg-destructive/90 px-1.5 py-0.5 text-[10px] text-white"
                      />
                    }
                  >
                    Rename failed
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{renameError}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {!font && nameEdit}
            {!font && !renaming && (
              <CopyNameLabel
                name={a.name}
                label={a.title}
                dark={a.type === "audio"}
                mention={mention}
                className={libraryNameClass(a.type)}
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
