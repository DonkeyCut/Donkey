"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useDeleteKey } from "@/cut/hooks/useDeleteKey";
import { useTabTitle } from "@/cut/hooks/useTabTitle";
import { setObjectDragImage } from "@/cut/lib/assetDrag";
import { useClipTitles } from "@/cut/lib/clipTitle";
import { additiveClick } from "@/cut/lib/hostKeys";
import { deleteFromLibrary, type LibraryAsset } from "@/cut/lib/library";
import { lightboxItemFromLibrary, useLightbox } from "@/cut/lib/lightbox";
import { patchLibrary, refetchLibrary, renameInLibrary, useLibrary } from "@/cut/lib/queries";
import { formatDate } from "@/cut/lib/time";
import { shapeBand } from "@/cut/lib/types";
import { Marquee, useTilePicks } from "./desktopFolders";
import { Lightbox } from "./Lightbox";
import { DeleteConfirm, SelectionMenu, pickLabel, useSelectionMenu } from "./selectionMenu";
import { LibraryCard } from "@/cut/components/LibraryCard";

/** The phone's recordings, synced up from the iOS app: every cloud library
 * asset tagged origin "camera", newest first. Clips here are ordinary library
 * assets — the editor's Library panel offers them to any project — this page
 * is where they are watched and pruned. The listing stays live while the tab
 * is open, so a recording made on the phone arrives on its own, and names
 * itself off what is said in it. Pruning picks the way every tile grid does:
 * click, ⌘ and ⇧ clicks, a sweep, then ⌫ or the right-click menu. */
export function CameraRollView() {
  const client = useQueryClient();
  // The phone fills this page, so it re-reads on a timer and whenever the
  // window comes back to the front: a clip finishes uploading and takes its
  // place in the grid — a shimmering tile first, the clip a moment later —
  // with nothing to reload.
  const library = useLibrary({ live: true });
  const [deleting, setDeleting] = useState<LibraryAsset[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clips = (library.data?.assets ?? []).filter((a) => a.origin === "camera");
  const patch = useCallback(
    (fn: Parameters<typeof patchLibrary>[1]) => patchLibrary(client, fn),
    [client]
  );
  useClipTitles(clips, patch);
  useTabTitle("Camera Roll");

  const remove = async (set: LibraryAsset[]) => {
    setDeleting(null);
    setSelected(new Set());
    const gone = new Set(set.map((a) => a.id));
    patch((d) => ({ ...d, assets: d.assets.filter((a) => !gone.has(a.id)) }));
    await Promise.all(set.map((a) => deleteFromLibrary(a.residency, a.id))).catch(
      () => void refetchLibrary(client),
    );
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

  // What can be picked, in the order a ⇧-range runs: the grid as it is laid out.
  const order = [...bands.values()].flat().map((a) => a.id);
  const { picked: selected, setPicked: setSelected, pick: pickTile } = useTilePicks(order);
  const pick = clips.filter((a) => selected.has(a.id));
  // A card inside the pick carries the whole set; outside it, itself.
  const setOf = (a: LibraryAsset) => (selected.has(a.id) ? pick : [a]);
  useDeleteKey(rootRef, pick.length > 0 ? () => setDeleting(pick) : null);
  const ctx = useSelectionMenu({ picked: selected, setPicked: setSelected, shown: order });
  const ctxSet = ctx.menu ? clips.filter((a) => ctx.menu!.ids.includes(a.id)) : [];
  // A drag out of a pick carries the pick, under the one ghost every drag wears.
  const onCardDragExtra = (e: React.DragEvent, a: LibraryAsset) => {
    if (!selected.has(a.id)) setSelected(new Set([a.id]));
    const ids = setOf(a).map((x) => x.id);
    setObjectDragImage(e, ids.length, [a.id, ...ids.filter((x) => x !== a.id)], () =>
      setSelected(new Set()),
    );
  };

  return (
    <div
      ref={rootRef}
      className="mx-auto w-full max-w-6xl px-10 py-9"
      onContextMenu={ctx.onContextMenu}
    >
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
        <Marquee
          className="flex min-h-[40vh] flex-col content-start gap-8"
          selected={selected}
          setSelected={setSelected}
        >
          {[...bands.values()].map((band, i) => (
            <div key={i} className="flex flex-wrap items-start gap-4">
              {band.map((a) => (
                <LibraryCard
                  key={a.id}
                  asset={a}
                  area={TILE_AREA}
                  caption={formatDate(a.addedAt)}
                  selected={selected.has(a.id)}
                  dragGroup={pick}
                  onClick={(e) => {
                    if (additiveClick(e)) {
                      e.preventDefault();
                      pickTile(e, a.id, order);
                    } else useLightbox.getState().open(lightboxItemFromLibrary(a, true));
                  }}
                  onDelete={() => setDeleting(setOf(a))}
                  onRename={(name) => renameInLibrary(client, a, name)}
                  onDragStartExtra={(e) => onCardDragExtra(e, a)}
                />
              ))}
            </div>
          ))}
        </Marquee>
      )}

      <SelectionMenu menu={ctxSet.length > 0 ? ctx.menu : null} onClose={ctx.close}>
        <DropdownMenuItem variant="destructive" onClick={() => setDeleting(ctxSet)}>
          <Trash2 /> Delete
        </DropdownMenuItem>
      </SelectionMenu>

      <DeleteConfirm
        open={!!deleting}
        title={
          deleting
            ? `Delete ${pickLabel([], deleting.map((a) => ({ name: a.title || a.name })), ["clip", "clips"], 0)}?`
            : ""
        }
        description={
          deleting?.length === 1
            ? "The clip leaves your cloud Camera Roll and the phone it was shot on. Projects that already use it keep their own copy."
            : "The clips leave your cloud Camera Roll and the phone they were shot on. Projects that already use them keep their own copy."
        }
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && void remove(deleting)}
      />

      <Lightbox />
    </div>
  );
}
