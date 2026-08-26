"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, Loader2 } from "lucide-react";
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
import { useClipTitles } from "@/cut/lib/clipTitle";
import { deleteFromLibrary, type LibraryAsset } from "@/cut/lib/library";
import { lightboxItemFromLibrary, useLightbox } from "@/cut/lib/lightbox";
import { patchLibrary, refetchLibrary, useLibrary } from "@/cut/lib/queries";
import { formatDate } from "@/cut/lib/time";
import { shapeBand } from "@/cut/lib/types";
import { Lightbox } from "./Lightbox";
import { LibraryCard } from "./LibraryView";

/** The phone's recordings, synced up from the iOS app: every cloud library
 * asset tagged origin "camera", newest first. Clips here are ordinary library
 * assets — the editor's Library panel offers them to any project — this page
 * is where they are watched and pruned. The listing stays live while the tab
 * is open, so a recording made on the phone arrives on its own, and names
 * itself off what is said in it. */
export function CameraRollView() {
  const client = useQueryClient();
  // The phone fills this page, so it re-reads on a timer and whenever the
  // window comes back to the front: a clip finishes uploading and takes its
  // place in the grid — a shimmering tile first, the clip a moment later —
  // with nothing to reload.
  const library = useLibrary({ live: true });
  const [deleting, setDeleting] = useState<LibraryAsset | null>(null);
  const clips = (library.data?.assets ?? []).filter((a) => a.origin === "camera");
  const patch = useCallback(
    (fn: Parameters<typeof patchLibrary>[1]) => patchLibrary(client, fn),
    [client]
  );
  useClipTitles(clips, patch);

  const remove = async () => {
    if (!deleting) return;
    const { id, residency } = deleting;
    setDeleting(null);
    patch((d) => ({ ...d, assets: d.assets.filter((a) => a.id !== id) }));
    await deleteFromLibrary(residency, id).catch(() => void refetchLibrary(client));
  };

  // Same banding as the Library grid: tiles of one shape share a row, every
  // tile carries the same area.
  const bands = new Map<number, LibraryAsset[]>();
  for (const a of clips) {
    const key = a.width && a.height ? shapeBand(a.width, a.height) : 0;
    const band = bands.get(key) ?? [];
    if (band.length === 0) bands.set(key, band);
    band.push(a);
  }
  const TILE_AREA = 180 * 320;

  return (
    <div className="mx-auto w-full max-w-6xl px-10 py-9">
      <div className="mb-5 flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold tracking-tight">Camera Roll</h1>
      </div>

      {!library.data && library.isPending ? (
        <div className="grid place-items-center py-24 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : clips.length === 0 ? (
        <div className="grid w-full place-items-center rounded-2xl py-24">
          <div className="flex flex-col items-center gap-3 text-center">
            <Camera className="size-8 text-muted-foreground" />
            <div className="text-base font-medium">Nothing from your phone yet.</div>
            <p className="text-sm text-muted-foreground">
              Clips you record in the Donkey Cut iOS app sync here automatically.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {[...bands.values()].map((band, i) => (
            <div key={i} className="flex flex-wrap items-start gap-4">
              {band.map((a) => (
                <LibraryCard
                  key={a.id}
                  asset={a}
                  area={TILE_AREA}
                  caption={formatDate(a.addedAt)}
                  onClick={() =>
                    useLightbox.getState().open(lightboxItemFromLibrary(a, true))
                  }
                  onDelete={() => setDeleting(a)}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.title || deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The clip leaves your cloud Camera Roll and the phone it was shot on. Projects that
              already use it keep their own copy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Lightbox />
    </div>
  );
}
