"use client";

import { useCallback, useState } from "react";
import { File as FileIcon, Plus, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useElapsed } from "@/cut/hooks/useElapsed";
import { AudioCardFace } from "@/cut/components/AudioPanel";
import { FontSpecimen } from "@/cut/components/FontSpecimen";
import { ImportVideoPoster } from "@/cut/components/ImportVideoPoster";
import { openLocalImport } from "@/cut/lib/localImportPreview";
import type { LibraryArrival } from "@/cut/lib/libraryIntake";
import { cn } from "@/lib/utils";

/** Local previews stay available while storage runs; failed imports keep their retry. */
export function LibraryImportCard({
  item,
  area,
  onRetry,
  onDismiss,
  onUse,
}: {
  item: LibraryArrival;
  area: number;
  onRetry: () => void;
  onDismiss: () => void;
  onUse?: () => void;
}) {
  const elapsed = useElapsed(item.error ? null : item.startedAt);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const file = item.file;
  const mediaType = item.mediaType;
  const previewKind = mediaType === "video" || mediaType === "image" || mediaType === "audio" ? mediaType : null;
  const canPreview = !!file && !!previewKind && !item.error;
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
  const frame = item.shape ?? { width: 1, height: 1 };
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
        "relative max-w-full overflow-hidden rounded-xl border",
        canPreview && "cursor-pointer",
        item.error ? "border-destructive/50 bg-muted" : "border-border",
      )}
      style={{
        width: Math.round(Math.sqrt((area * frame.width) / frame.height)),
        aspectRatio: `${frame.width} / ${frame.height}`,
      }}
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
      ) : previewUrl && mediaType === "audio" ? (
        <AudioCardFace url={previewUrl} duration={0} durationClassName="hidden" />
      ) : previewUrl && mediaType === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element -- local file preview
        <img src={previewUrl} alt={item.name} className="size-full object-cover" />
      ) : previewUrl && mediaType === "font" ? (
        <FontSpecimen assetId={item.id} src={previewUrl} fitHeight className="size-full" />
      ) : file && mediaType === "video" ? (
        <ImportVideoPoster file={file} size={Math.ceil(Math.sqrt(area))} />
      ) : file && mediaType !== "image" && mediaType !== "audio" ? (
        <div className="flex size-full flex-col items-center justify-center gap-2 bg-muted text-muted-foreground">
          <FileIcon className="size-8" />
          <span className="text-xs uppercase">{mediaType ?? "Archive"}</span>
        </div>
      ) : (
        <Skeleton className="size-full rounded-none" />
      )}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={cn(
                  "absolute top-1.5 left-1.5 truncate rounded-lg bg-black/55 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-sm",
                  item.error ? "max-w-[calc(100%-4rem)]" : "max-w-[70%]",
                )}
              />
            }
          >
            {item.name}
          </TooltipTrigger>
          <TooltipContent className="max-w-xs break-all">
            {item.source ?? item.name}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {canPreview && onUse && (
        <Button size="icon-sm" variant="secondary" className="absolute top-1.5 right-1.5" aria-label={`Add ${item.name} to project`}
          onClick={(event) => { event.stopPropagation(); onUse(); }}>
          <Plus />
        </Button>
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
        <span
          className={cn(
            "absolute bottom-1.5 flex items-center gap-1 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] text-white",
            mediaType === "audio"
              ? "right-1.5 max-w-[calc(100%-3.5rem)]"
              : "left-1.5 max-w-[calc(100%-0.75rem)]",
          )}
        >
          <span className="truncate">Importing</span>
          <span className="shrink-0 font-mono tabular-nums">{elapsed}</span>
        </span>
      )}
    </div>
  );
}
