"use client";

import { useState, type ReactNode } from "react";
import { Clapperboard, Download, Ellipsis, FolderPlus, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { saveAssetToLibrary } from "@/cut/lib/library";
import { downloadMedia } from "@/cut/lib/media";
import { useEditor } from "@/cut/lib/store";
import type { MediaAsset } from "@/cut/lib/types";

/** The "…" menu on a generated asset (image tile, video job row, voiceover
 * row). Every surface gets the same pair — move the asset into the Media
 * panel (drop its `origin` tag) or copy it into the shared library — and
 * slots its own actions around them via `before`/`after`.
 *
 * `onDelete` adds the destructive item and its confirmation: the asset takes
 * its media file with it, so a delete that would also empty places on the
 * timeline says how many before it happens, and nothing brings them back. */
export function GeneratedAssetMenu({
  asset,
  projectId,
  triggerClassName,
  before,
  after,
  onDelete,
  deleteLabel = "Delete",
}: {
  asset: MediaAsset;
  projectId: string;
  triggerClassName: string;
  before?: ReactNode;
  after?: ReactNode;
  onDelete?: () => void;
  deleteLabel?: string;
}) {
  // Timeline items the delete would take with it; null = no prompt open.
  const [confirmUses, setConfirmUses] = useState<number | null>(null);

  const remove = () => {
    if (!onDelete) return;
    const s = useEditor.getState();
    const uses =
      s.clips.filter((c) => c.assetId === asset.id).length +
      s.audioClips.filter((c) => c.assetId === asset.id).length;
    // Deleting something the cut never used costs the user nothing to redo.
    if (uses > 0) setConfirmUses(uses);
    else onDelete();
  };

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="More actions"
        title="More actions"
        className={triggerClassName}
      >
        <Ellipsis className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {before}
        {before != null && <DropdownMenuSeparator />}
        <DropdownMenuItem
          onClick={() =>
            // Clearing the origin files it into Media; a chat-owned asset also
            // sheds its thread so deleting the chat won't touch it.
            useEditor.getState().updateAsset(asset.id, { origin: undefined, chatId: undefined })
          }
        >
          <Clapperboard /> Add to Media
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            void saveAssetToLibrary(projectId, asset).catch(() => {
              // Library write failed; nothing to roll back.
            })
          }
        >
          <FolderPlus /> Add to Library
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => downloadMedia(projectId, asset)}
          disabled={!!asset.upload}
        >
          <Download /> Download
        </DropdownMenuItem>
        {(after != null || onDelete) && <DropdownMenuSeparator />}
        {after}
        {onDelete && (
          <DropdownMenuItem variant="destructive" onClick={remove}>
            <Trash2 /> {deleteLabel}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    <AlertDialog open={confirmUses !== null} onOpenChange={(o) => !o && setConfirmUses(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{asset.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {confirmUses === 1
              ? "It plays in 1 place on the timeline, which goes with it."
              : `It plays in ${confirmUses} places on the timeline, which go with it.`}{" "}
            The media file is deleted too, and this can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            onClick={() => {
              setConfirmUses(null);
              onDelete?.();
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
