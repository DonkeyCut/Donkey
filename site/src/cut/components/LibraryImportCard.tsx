"use client";

import { useCallback, useState } from "react";
import { File as FileIcon, Loader2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useElapsed } from "@/cut/hooks/useElapsed";
import { AudioCardFace } from "@/cut/components/AudioPanel";
import { CardActionsMenu } from "@/cut/components/CardActionsMenu";
import { FontSpecimen } from "@/cut/components/FontSpecimen";
import { ImportVideoPoster } from "@/cut/components/ImportVideoPoster";
import {
  LIBRARY_TILE_AREA,
  LibraryFontFace,
  LibraryLutFace,
  libraryNameClass,
  libraryTileBox,
} from "@/cut/components/LibraryCard";
import { lutFileName } from "@/cut/lib/library";
import { openLocalImport } from "@/cut/lib/localImportPreview";
import { setLibraryImportShape, type LibraryArrival } from "@/cut/lib/libraryIntake";
import { fileKind } from "@/cut/lib/media";
import { formatBytes } from "@/lib/bytes";
import { cn } from "@/lib/utils";

/** An arriving file wears the tile its asset will, with a spinner in the
 * corner while storage runs; failed imports keep their retry. */
export function LibraryImportCard({
  item,
  area,
  onRetry,
  onDismiss,
  onUse,
}: {
  item: LibraryArrival;
  /** The finished card's area; unset, the tile fills its grid cell. */
  area?: number;
  onRetry: () => void;
  onDismiss: () => void;
  onUse?: () => void;
}) {
  const elapsed = useElapsed(item.error ? null : item.startedAt);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const file = item.file;
  const mediaType = item.mediaType;
  const font = mediaType === "font";
  const previewKind = mediaType === "video" || mediaType === "image" || mediaType === "audio" ? mediaType : null;
  const canPreview = !!file && !!previewKind && !item.error;
  // Only media goes on a timeline; a font or LUT is used from its own menu.
  const use = canPreview ? onUse : undefined;
  const openPreview = () => {
    if (file && previewKind) openLocalImport(file, previewKind);
  };
  const tileRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !file || (mediaType !== "image" && mediaType !== "audio" && mediaType !== "font")) return;
      let url: string | undefined;
      const observer = new IntersectionObserver(
        (entries) => {
          const visible = entries.some((entry) => entry.isIntersecting);
          if (visible && !url) {
            url = URL.createObjectURL(file);
            setPreviewUrl(url);
          } else if (!visible && url) {
            URL.revokeObjectURL(url);
            url = undefined;
            setPreviewUrl(undefined);
          }
        },
        { rootMargin: "150px" },
      );
      observer.observe(node);
      return () => {
        observer.disconnect();
        if (url) URL.revokeObjectURL(url);
      };
    },
    [file, mediaType],
  );
  const measured = (shape: { width: number; height: number }) => {
    if (shape.width !== item.shape?.width || shape.height !== item.shape?.height)
      setLibraryImportShape(item.id, shape);
  };
  const box = libraryTileBox(mediaType, item.shape, area);
  const name = mediaType === "lut" ? lutFileName(item.name) : item.name;
  return (
    <div
      ref={tileRef}
      role={canPreview ? "button" : undefined}
      tabIndex={canPreview ? 0 : undefined}
      aria-label={canPreview ? `Preview ${item.name}` : undefined}
      onDoubleClick={canPreview ? openPreview : undefined}
      onKeyDown={canPreview ? (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openPreview();
      } : undefined}
      draggable={canPreview}
      onDragStart={canPreview ? (event) => {
        event.dataTransfer.items.clear();
        event.dataTransfer.items.add(file!);
        event.dataTransfer.effectAllowed = "copy";
      } : undefined}
      className={cn(
        "group",
        box.className,
        canPreview && "cursor-pointer",
        item.error ? "border-destructive/50 bg-muted" : font ? "border-transparent" : "border-border",
      )}
      style={item.error ? { ...box.style, backgroundColor: undefined, color: undefined } : box.style}
    >
      {item.error ? (
        // Clear of the strip the link and the reason share along the top.
        <div className="flex size-full flex-col items-center justify-center gap-1.5 pt-8">
          <Button
            variant="outline"
            size="sm"
            className="w-24 justify-start"
            onClick={onRetry}
          >
            <RotateCcw data-icon="inline-start" /> Retry
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-24 justify-start text-destructive hover:text-destructive"
            onClick={onDismiss}
          >
            <X data-icon="inline-start" /> Cancel
          </Button>
        </div>
      ) : font ? (
        <LibraryFontFace
          name={item.name}
          meta={[fileKind(item.name), file && formatBytes(file.size)].filter(Boolean).join(" · ")}
          specimen={previewUrl && <FontSpecimen assetId={item.id} src={previewUrl} pad={0} className="size-full" />}
        />
      ) : mediaType === "lut" ? (
        <LibraryLutFace />
      ) : previewUrl && mediaType === "audio" ? (
        <AudioCardFace url={previewUrl} duration={0} durationClassName="hidden" />
      ) : previewUrl && mediaType === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element -- local file preview
        <img
          src={previewUrl}
          alt={item.name}
          className="size-full object-cover"
          onLoad={(event) => measured({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        />
      ) : file && mediaType === "video" ? (
        <ImportVideoPoster file={file} size={Math.ceil(Math.sqrt(area ?? LIBRARY_TILE_AREA))} onShape={measured} />
      ) : file && !mediaType ? (
        <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <FileIcon className="size-8" />
          <span className="text-xs uppercase">Archive</span>
        </div>
      ) : (
        <Skeleton className="size-full rounded-none" />
      )}
      {!font && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    libraryNameClass(mediaType),
                    "truncate",
                    item.error && "max-w-[calc(100%-4rem)] group-hover:max-w-[calc(100%-4rem)]",
                  )}
                />
              }
            >
              {name}
            </TooltipTrigger>
            <TooltipContent className="max-w-xs break-all">
              {item.source ?? item.name}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {item.error ? (
        // The reason rides in the tooltip: on a tile this size the message
        // itself would cover the media it stands in for.
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="absolute top-1.5 right-1.5 rounded-md bg-destructive/90 px-1.5 py-0.5 text-[10px] text-white" />
              }
            >
              Failed
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{item.error}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <>
          {/* The spinner holds the corner the finished card's actions take;
              one with somewhere to go gives way to its menu on hover. */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label="Importing"
                    className={cn(
                      "absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-full text-white transition-opacity",
                      font ? "bg-white/10" : "bg-black/40",
                      use && "group-hover:opacity-0",
                    )}
                  />
                }
              >
                <Loader2 className="size-3.5 animate-spin" />
              </TooltipTrigger>
              <TooltipContent>
                Importing <span className="font-mono tabular-nums">{elapsed}</span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <CardActionsMenu sheet={font} className="absolute top-1.5 right-1.5" onUse={use} />
        </>
      )}
    </div>
  );
}
