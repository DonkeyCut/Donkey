"use client";

import type { ReactNode } from "react";
import { Download, Ellipsis, ExternalLink, Pencil, Plus, Share2, Trash2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** The "…" menu every Library card carries: a round button revealed on
 * hover, and a menu hung off the card's right edge so the tile stays
 * readable behind it. Each action shows when its handler is given, always in
 * the same order. */
export function CardActionsMenu({
  label = "More actions",
  icon,
  sheet = false,
  className,
  onUse,
  useTitle = "Add to timeline",
  onShare,
  shareDisabled,
  onRename,
  onDownload,
  downloadHref,
  downloadDisabled,
  onOpenOriginal,
  extra,
  onDelete,
}: {
  label?: string;
  /** The button's glyph in place of the ellipsis, e.g. a check after a save. */
  icon?: ReactNode;
  /** On the charcoal font sheet a black scrim disappears, so the button lightens it. */
  sheet?: boolean;
  /** Where the button sits; a tile pins it to its top-right corner. */
  className?: string;
  onUse?: () => void;
  useTitle?: string;
  onShare?: () => void;
  shareDisabled?: boolean;
  onRename?: () => void;
  onDownload?: () => void;
  /** A protected link to save the file from, for a viewer outside the library. */
  downloadHref?: string;
  downloadDisabled?: boolean;
  onOpenOriginal?: () => void;
  extra?: ReactNode;
  onDelete?: () => void;
}) {
  const middle = !!(onShare || onRename || onDownload || downloadHref || onOpenOriginal || extra);
  if (!onUse && !middle && !onDelete) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className={cn(
          "grid size-6 place-items-center rounded-full text-white opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100",
          sheet ? "bg-white/10 hover:bg-white/20" : "bg-black/40 hover:bg-black/60",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {icon ?? <Ellipsis className="size-3.5" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        alignOffset={4}
        className="w-44"
        onClick={(e) => e.stopPropagation()}
      >
        {onUse && (
          <>
            <DropdownMenuItem onClick={onUse}>
              <Plus /> {useTitle}
            </DropdownMenuItem>
            {(middle || onDelete) && <DropdownMenuSeparator />}
          </>
        )}
        {onShare && (
          <DropdownMenuItem disabled={shareDisabled} onClick={onShare}>
            <Share2 /> Share
          </DropdownMenuItem>
        )}
        {onRename && (
          <DropdownMenuItem onClick={onRename}>
            <Pencil /> Rename
          </DropdownMenuItem>
        )}
        {downloadHref ? (
          <DropdownMenuItem render={<a href={downloadHref} />}>
            <Download /> Download
          </DropdownMenuItem>
        ) : onDownload ? (
          <DropdownMenuItem disabled={downloadDisabled} onClick={onDownload}>
            <Download /> Download
          </DropdownMenuItem>
        ) : null}
        {onOpenOriginal && (
          // An imported clip keeps the link it came from, so the post it was
          // cut out of is one click away.
          <DropdownMenuItem onClick={onOpenOriginal}>
            <ExternalLink /> Open original
          </DropdownMenuItem>
        )}
        {extra}
        {onDelete && (
          <>
            {middle && <DropdownMenuSeparator />}
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
