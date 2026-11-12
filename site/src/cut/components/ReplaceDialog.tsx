"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Film, Loader2, Music, Upload, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { retimeOf } from "@donkeycut/effects-kit";
import { Button } from "@/components/ui/button";
import { Popover } from "@base-ui/react/popover";
import { DialogBody } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useDescribeError } from "@/i18n/describeError";
import { useHoverPlay } from "@/cut/hooks/useHoverPlay";
import { useInView } from "@/cut/hooks/useInView";
import { FOCUS_RING } from "@/cut/lib/assetPick";
import { useLocalCompute } from "@/cut/lib/backend/hooks";
import { planFilmstrip } from "@/cut/lib/filmstrip";
import { childrenOf, folderTrail } from "@/cut/lib/folderTree";
import { importLibraryAsset, type LibraryAsset } from "@/cut/lib/library";
import {
  ensurePeaks,
  mediaAccept,
  peekEdgeFrame,
  requestEdgeFrame,
} from "@/cut/lib/media";
import { isLottieAsset } from "@/cut/lib/lottieAssets";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { useLibrary } from "@/cut/lib/queries";
import {
  FITS_SLACK_S,
  replaceTypes,
  type ReplaceTarget,
} from "@/cut/lib/replaceItem";
import {
  closeReplace,
  commitReplace,
  currentAssetOf,
  isStickerTarget,
  slotOf,
  useReplaceTarget,
} from "@/cut/lib/replaceFlow";
import { useEditor } from "@/cut/lib/store";
import { formatTime } from "@/cut/lib/time";
import {
  isLinkedAssetType,
  previewUrl,
  type AssetType,
  type MediaAsset,
} from "@/cut/lib/types";
import { useLocalPref } from "@/cut/lib/uiState";
import { AssetTileFace } from "./AssetTileFace";
import { FolderCrumb, FolderShelf } from "./desktopFolders";
import { LibraryCard } from "./LibraryCard";
import { MediaTransport } from "./MediaTransport";
import { SubTabs } from "./SubTabs";

/**
 * Replace: swap what a timeline item plays. Step one picks a file from
 * Project Files, or uploads one; step two, for footage or sound longer than
 * the item's slot, slides a window the slot's length over the new source to
 * choose the stretch that plays. Stills and short sources replace on pick.
 *
 *   ⋮ Replace… ─▶ [ media grid ] ─pick─▶ fits? ─yes─▶ replaced
 *                                         │no
 *                                         ▼
 *                                 [ preview + window ] ─Replace─▶ replaced
 */

/** Strip height, px: the window step's filmstrip and waveform. */
const STRIP_H = 56;
/** Narrowest a tile of the strip draws, px. */
const STRIP_MIN_TILE = 26;
/** One arrow press moves the window this far, seconds. */
const NUDGE_S = 0.1;

type Imports = (
  files: FileList | File[],
  opts?: {
    mediaOnly?: boolean;
    onOutcome?: (
      result: { file: File; assetId: string } | { file: File; failed: true },
    ) => void;
  },
) => void;

/** Whether a Project Files file can go in the item: an import (no origin),
 * of a kind it plays, other than what it plays now. An animated sticker only
 * goes on a sticker. */
function swappable(
  a: MediaAsset,
  types: AssetType[],
  current: string | undefined,
  sticker: boolean,
): boolean {
  if (
    a.origin != null ||
    a.id === current ||
    isLinkedAssetType(a.type) ||
    !types.includes(a.type)
  ) {
    return false;
  }
  return sticker || !isLottieAsset(a);
}

/** Gap between the popover's tail and the item it points at, px. */
const TAIL_GAP = 10;
/** Room the popover keeps from the window's edges, px. */
const EDGE_PAD = 12;

/** The item's block on the timeline, which the popover's tail points at. An
 * item scrolled out of the DOM leaves a point low in the middle of the
 * window, over where the timeline sits. */
function anchorOf(
  target: ReplaceTarget,
): () => Element | { getBoundingClientRect: () => DOMRect } {
  return () => {
    const el = document.querySelector(
      `[data-tl-sel="${target.kind}:${target.id}"]`,
    );
    if (el) {
      return el;
    }
    return {
      getBoundingClientRect: () =>
        new DOMRect(window.innerWidth / 2, window.innerHeight * 0.75, 0, 0),
    };
  };
}

export function ReplaceDialog({ onImport }: { onImport: Imports }) {
  const target = useReplaceTarget((s) => s.target);
  const mode = useReplaceTarget((s) => s.mode);
  const t = useTranslations("timeline.replace");
  const tc = useTranslations("common.dialog");
  const anchor = useMemo(
    () => (target ? anchorOf(target) : undefined),
    [target],
  );
  return (
    <Popover.Root
      open={target !== null}
      modal
      onOpenChange={(open) => !open && closeReplace()}
    >
      <Popover.Portal>
        <Popover.Positioner
          className="isolate z-50 outline-none"
          anchor={anchor}
          side="top"
          sideOffset={TAIL_GAP}
          collisionPadding={EDGE_PAD}
        >
          <Popover.Popup className="relative flex max-h-(--available-height) w-[min(36rem,calc(100vw-1.5rem))] origin-(--transform-origin) flex-col gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10 duration-100 outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95">
            {/* The tail: a square turned on its point, bordered on its two
                outer sides to continue the card's edge. */}
            <Popover.Arrow className="size-3.5 rotate-45 border-foreground/10 bg-popover data-[side=bottom]:-top-[7px] data-[side=bottom]:border-t data-[side=bottom]:border-l data-[side=top]:-bottom-[7px] data-[side=top]:border-r data-[side=top]:border-b" />
            <Popover.Title className="font-heading text-base leading-none font-medium">
              {mode === "adjust" ? t("adjustTitle") : t("title")}
            </Popover.Title>
            <Popover.Close
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-2 right-2"
                />
              }
            >
              <X />
              <span className="sr-only">{tc("close")}</span>
            </Popover.Close>
            {/* Keyed on the item, so a second Replace starts on the grid. */}
            {target && mode === "replace" && (
              <ReplaceFlow
                key={`${target.kind}:${target.id}`}
                target={target}
                onImport={onImport}
              />
            )}
            {target && mode === "adjust" && (
              <AdjustFlow key={`${target.kind}:${target.id}`} target={target} />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ReplaceFlow({
  target,
  onImport,
}: {
  target: ReplaceTarget;
  onImport: Imports;
}) {
  const [picked, setPicked] = useState<{
    asset: MediaAsset;
    slot: number;
  } | null>(null);

  // Picking: a still or a source no longer than the slot fills it whole and
  // the dialog closes; a longer one opens the window step.
  const pick = useCallback(
    (asset: MediaAsset) => {
      const slot = slotOf(target);
      if (slot === null) {
        closeReplace();
        return;
      }
      if (asset.type === "image" || asset.duration <= slot + FITS_SLACK_S) {
        commitReplace(target, asset, 0);
        closeReplace();
        return;
      }
      setPicked({ asset, slot });
    },
    [target],
  );

  if (picked) {
    return (
      <WindowStep
        asset={picked.asset}
        slot={picked.slot}
        onBack={() => setPicked(null)}
        onConfirm={(from) => {
          commitReplace(target, picked.asset, from);
          closeReplace();
        }}
      />
    );
  }
  return <PickStep target={target} onImport={onImport} onPick={pick} />;
}

type Shelf = "project" | "library";

function PickStep({
  target,
  onImport,
  onPick,
}: {
  target: ReplaceTarget;
  onImport: Imports;
  onPick: (asset: MediaAsset) => void;
}) {
  const t = useTranslations("timeline.replace");
  const tm = useTranslations("media.mediaPanel");
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const types = useMemo(() => replaceTypes(target.kind), [target.kind]);
  const current = useMemo(() => currentAssetOf(target), [target]);
  const sticker = useMemo(() => isStickerTarget(target), [target]);

  // The Media panel's two shelves; the last one used opens next time. A
  // shared view has no Library: that shelf is the viewer's own.
  const sharedFeatures = useEditor((s) => s.sharedFeatures);
  const [sub, setSub] = useLocalPref<Shelf>(
    "cut-replace-shelf",
    "project",
    (v) => v === "project" || v === "library",
  );
  const shelf: Shelf = sharedFeatures ? "project" : sub;

  // An upload lands in Project Files like any other import, then is picked.
  const upload = (list: FileList) => {
    setBusy(true);
    onImport(list, {
      mediaOnly: true,
      onOutcome: (result) => {
        setBusy(false);
        if ("failed" in result) {
          return;
        }
        const asset = useEditor
          .getState()
          .assets.find((a) => a.id === result.assetId);
        if (asset) {
          onPick(asset);
        }
      },
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* The shelves on the left, Upload on the right, one height. */}
      <div className="flex items-center gap-3">
        {!sharedFeatures && (
          <SubTabs
            className="h-8 w-60 text-xs"
            tabs={[
              { id: "project", label: tm("projectFiles") },
              { id: "library", label: tm("library") },
            ]}
            value={shelf}
            onChange={setSub}
          />
        )}
        <Button
          variant="outline"
          className="ml-auto"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <Upload data-icon="inline-start" />
          )}
          {t("upload")}
        </Button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={mediaAccept(types)}
        hidden
        onChange={(e) => {
          if (e.target.files?.length) {
            upload(e.target.files);
          }
          e.target.value = "";
        }}
      />
      <UploadButton.Provider
        value={{ browse: () => inputRef.current?.click(), busy }}
      >
        {shelf === "project" ? (
          <ProjectShelf
            types={types}
            current={current}
            sticker={sticker}
            onPick={onPick}
          />
        ) : (
          <LibraryShelf
            types={types}
            sticker={sticker}
            busy={busy}
            setBusy={setBusy}
            onPick={onPick}
          />
        )}
      </UploadButton.Provider>
    </div>
  );
}

/** The grid both shelves draw: tiles at the Media panel's size, as many
 * across as the dialog holds. */
const PICK_GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] content-start gap-2.5 p-1";

/** No drag carries this type, so the read-only crumb and folder rows take no
 * drops. */
const NO_DROP_MIME = "application/x-donkey-replace-none";
const noop = () => {};

/** The pick step's file browser, so an empty shelf can offer it too. */
const UploadButton = createContext<{ browse: () => void; busy: boolean }>({
  browse: () => {},
  busy: false,
});

/** The empty shelf: its kinds' icons over a line and an Upload media button. Centered on the whole
 * card: the bottom padding matches the title and tab rows above the shelf,
 * so the shelf's center sits at the card's. */
function EmptyShelf({ text }: { text: string }) {
  const t = useTranslations("timeline.replace");
  const { browse, busy } = useContext(UploadButton);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 pb-21 text-center text-xs leading-relaxed text-balance text-muted-foreground">
      <div className="flex gap-3.5">
        <Film className="size-5" />
        <Music className="size-5" />
      </div>
      {text}
      <Button disabled={busy} onClick={browse}>
        {busy ? (
          <Loader2 data-icon="inline-start" className="animate-spin" />
        ) : (
          <Upload data-icon="inline-start" />
        )}
        {t("uploadMedia")}
      </Button>
    </div>
  );
}

/** One shelf, walked like the Media panel: the crumb back up while a folder
 * is open, the folders filed at this level as rows, then the files that fit.
 * The folders only open here; renaming, deleting and filing stay in the
 * panel. */
function ShelfView({
  root,
  trail,
  folders,
  countOf,
  onGo,
  empty,
  note,
  children,
}: {
  root: string;
  trail: { id: string; name: string }[];
  folders: { id: string; name: string }[];
  countOf: (id: string) => number;
  onGo: (id: string | null) => void;
  /** What the shelf says with nothing in it at the top. */
  empty: string;
  /** A line over the grid: a pick that failed. */
  note?: string | null;
  /** The file tiles at this level; none renders nothing. */
  children: React.ReactNode[];
}) {
  const t = useTranslations("media.projectFiles");
  const inFolder = trail.length > 0;
  const bare = folders.length === 0 && children.length === 0;
  return (
    <div className="flex h-[34rem] min-h-0 shrink flex-col">
      {inFolder && (
        <div className="flex h-9 shrink-0 items-center pb-1.5">
          <FolderCrumb
            className="text-sm"
            root={root}
            trail={trail}
            mime={NO_DROP_MIME}
            onGo={onGo}
            onDrop={noop}
          />
        </div>
      )}
      <DialogBody className="flex-1">
        {note && <p className="px-1 pb-2 text-xs text-destructive">{note}</p>}
        {bare && !inFolder && <EmptyShelf text={empty} />}
        {bare && inFolder && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t("emptyFolder")}
          </p>
        )}
        <FolderShelf
          layout="rows"
          folders={folders.map((f) => ({ ...f, locked: true }))}
          mime={NO_DROP_MIME}
          statOf={(id) => ({ count: countOf(id) })}
          onOpen={onGo}
          onRename={noop}
          onDelete={noop}
          onDropIds={noop}
        />
        {children.length > 0 && <div className={PICK_GRID}>{children}</div>}
      </DialogBody>
    </div>
  );
}

/** Project Files: the files the person imported, of the kinds the item
 * plays, newest first, minus the one it plays now, in the panel's folders. */
function ProjectShelf({
  types,
  current,
  sticker,
  onPick,
}: {
  types: AssetType[];
  current: string | undefined;
  sticker: boolean;
  onPick: (asset: MediaAsset) => void;
}) {
  const t = useTranslations("timeline.replace");
  const tp = useTranslations("media.projectFiles");
  const assets = useEditor((s) => s.assets);
  const folders = useEditor((s) => s.mediaFolders);
  const [open, setOpen] = useState<string | null>(null);
  const files = useMemo(
    () => assets.filter((a) => swappable(a, types, current, sticker)).reverse(),
    [assets, types, current, sticker],
  );
  const openFolder = folders.find((f) => f.id === open);
  const here = files.filter(
    (a) => (a.folderId ?? null) === (openFolder?.id ?? null),
  );
  return (
    <ShelfView
      root={tp("root")}
      trail={openFolder ? [openFolder] : []}
      folders={openFolder ? [] : folders}
      countOf={(id) => files.filter((a) => a.folderId === id).length}
      onGo={setOpen}
      empty={t("empty")}
    >
      {here.map((asset) => (
        <PickTile key={asset.id} asset={asset} onPick={() => onPick(asset)} />
      ))}
    </ShelfView>
  );
}

/** The Library: every reachable shelf's files of the kinds the item plays,
 * newest first, in its folders. A pick copies the file into the project, then
 * swaps it in. */
function LibraryShelf({
  types,
  sticker,
  busy,
  setBusy,
  onPick,
}: {
  types: AssetType[];
  sticker: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onPick: (asset: MediaAsset) => void;
}) {
  const t = useTranslations("timeline.replace");
  const tl = useTranslations("media.library");
  const projectId = useEditor((s) => s.projectId);
  const library = useLibrary();
  const engineUp = useLocalCompute();
  const describeError = useDescribeError();
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const reachable = (r: LibraryAsset["residency"]) => r !== "local" || engineUp;
  const files = useMemo(
    () =>
      (library.data?.assets ?? [])
        .filter(
          (a) =>
            (a.residency !== "local" || engineUp) &&
            !isLinkedAssetType(a.type) &&
            types.includes(a.type) &&
            (sticker || !isLottieAsset(a)),
        )
        .sort((a, b) => b.addedAt - a.addedAt),
    [library.data, engineUp, types, sticker],
  );
  const folders = (library.data?.folders ?? []).filter((f) =>
    reachable(f.residency),
  );

  // Where a file shows: the folder it is filed in, or the root.
  const folderOf = (a: LibraryAsset) => a.folderId ?? null;
  const level = childrenOf(folders, open);
  const trail = folderTrail(folders, open);

  const take = async (lib: LibraryAsset) => {
    if (busy || !projectId) {
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      onPick(await importLibraryAsset(projectId, lib));
    } catch (err) {
      setFailed(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (library.data === undefined && !library.isError) {
    return (
      <div className="flex h-[34rem] min-h-0 shrink items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return (
    <ShelfView
      root={tl("root")}
      trail={trail}
      folders={level}
      countOf={(id) =>
        files.filter((a) => folderOf(a) === id).length +
        childrenOf(folders, id).length
      }
      onGo={setOpen}
      empty={t("libraryEmpty")}
      note={failed}
    >
      {files
        .filter((a) => folderOf(a) === open)
        .map((lib) => (
          <LibraryCard
            key={lib.id}
            asset={lib}
            onClick={() => void take(lib)}
          />
        ))}
    </ShelfView>
  );
}

/** A Project Files file in the grid, drawn as the Media panel draws it: the
 * video on its first frame, playing while hovered, its length, its name. */
function PickTile({
  asset,
  onPick,
}: {
  asset: MediaAsset;
  onPick: () => void;
}) {
  const [tileRef, seen] = useInView<HTMLDivElement>();
  const { ref: videoRef, handlers: hoverPlay } = useHoverPlay(0.1, "silent");

  // A div answering like a button: the audio face carries its own play
  // button, and a button may not hold another.
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "group flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-xl text-left",
        FOCUS_RING,
      )}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") {
          return;
        }
        e.preventDefault();
        onPick();
      }}
      {...hoverPlay}
    >
      {/* A file looks the same in both themes, like the Media panel's. */}
      <div
        ref={tileRef}
        className="light relative aspect-square overflow-hidden rounded-xl border border-page-border bg-muted bg-clip-padding shadow-sm transition-colors group-hover:border-page-input"
      >
        <AssetTileFace asset={asset} videoRef={videoRef} seen={seen} />
        {asset.type === "audio" && (
          <span className="absolute top-1.5 left-1.5 max-w-[70%] truncate rounded-md bg-black/25 px-2 py-1 text-[11px] font-medium text-white">
            {asset.name}
          </span>
        )}
      </div>
      {asset.type !== "audio" && (
        <span className="truncate text-[11px] text-muted-foreground">
          {asset.name}
        </span>
      )}
    </div>
  );
}

/** A waveform from normalized peaks, as bars across its box. */
function Peaks({
  peaks,
  className,
  style,
}: {
  peaks?: number[];
  className?: string;
  style?: React.CSSProperties;
}) {
  if (!peaks?.length) {
    return null;
  }
  const n = peaks.length;
  return (
    <svg
      viewBox={`0 0 ${n} 100`}
      preserveAspectRatio="none"
      className={className}
      style={style}
      aria-hidden
    >
      {peaks.map((p, i) => {
        const h = Math.max(2, p * 100);
        return (
          <rect
            key={i}
            x={i + 0.15}
            y={(100 - h) / 2}
            width={0.7}
            height={h}
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
}

/** Adjust: the window step on the clip's own file, starting on the part it
 * plays now. Confirming slides the clip's in and out together, so it keeps
 * its place and its length on the timeline. */
function AdjustFlow({ target }: { target: ReplaceTarget }) {
  const t = useTranslations("timeline.replace");
  const s = useEditor.getState();
  const clip =
    target.kind === "clip"
      ? s.clips.find((c) => c.id === target.id)
      : target.kind === "audio"
        ? s.audioClips.find((a) => a.id === target.id)
        : undefined;
  const asset = clip && s.assets.find((a) => a.id === clip.assetId);

  // The clip or its file went while the menu was open: nothing to adjust.
  useEffect(() => {
    if (!clip || !asset) {
      closeReplace();
    }
  }, [clip, asset]);
  if (!clip || !asset) {
    return null;
  }

  const span = clip.out - clip.in;
  return (
    <WindowStep
      asset={asset}
      slot={span}
      start={clip.in}
      confirmLabel={t("apply")}
      onConfirm={(from) => {
        const at = { in: from, out: from + span };
        if (target.kind === "clip") {
          useEditor.getState().updateClip(target.id, at);
        } else {
          useEditor.getState().updateAudio(target.id, at);
        }
        closeReplace();
      }}
    />
  );
}

/** Step two: the new source under a window the slot's length. The preview
 * plays the window's stretch on a loop; sliding the window, or the arrow keys
 * on it, moves that stretch through the source. */
function WindowStep({
  asset,
  slot,
  start = 0,
  confirmLabel,
  onBack,
  onConfirm,
}: {
  asset: MediaAsset;
  slot: number;
  /** Source second the window opens on. */
  start?: number;
  confirmLabel?: string;
  /** Back to the grid; absent where the step is the whole flow. */
  onBack?: () => void;
  onConfirm: (from: number) => void;
}) {
  const t = useTranslations("timeline.replace");
  const maxFrom = Math.max(0, asset.duration - slot);
  const [from, setFrom] = useState(() => Math.max(0, Math.min(maxFrom, start)));
  const fromRef = useRef(from);
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [muted, setMuted] = useState(false);
  // The file itself, as the Media panel's viewer plays it.
  const src = asset.url;

  // Sound draws its waveform; the peaks may still be on their way.
  useEffect(() => {
    if (asset.type === "audio") {
      void ensurePeaks(asset);
    }
  }, [asset]);
  const peaks = useEditor(
    (s) => s.assets.find((a) => a.id === asset.id)?.peaks,
  );

  // The window moves; the preview follows to its head, one seek per frame.
  const seekFrame = useRef(0);
  const moveTo = useCallback(
    (next: number) => {
      const at = Math.max(0, Math.min(maxFrom, next));
      fromRef.current = at;
      setFrom(at);
      setTime(0);
      if (seekFrame.current) {
        return;
      }
      seekFrame.current = requestAnimationFrame(() => {
        seekFrame.current = 0;
        const el = mediaRef.current;
        if (el) {
          el.currentTime = fromRef.current;
        }
      });
    },
    [maxFrom],
  );
  useEffect(
    () => () => {
      cancelAnimationFrame(seekFrame.current);
      seekFrame.current = 0;
    },
    [],
  );

  // The element is closed when the step goes: src cleared and reloaded, so
  // the browser lets its decoder go. An effect that runs again (React's dev
  // remount) puts the source back.
  useEffect(() => {
    const el = mediaRef.current;
    if (el && !el.getAttribute("src")) {
      el.src = src;
    }
    return () => {
      if (!el) {
        return;
      }
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, [src]);

  // Playback stays inside the window, looping back to its head.
  const onTimeUpdate = () => {
    const el = mediaRef.current;
    if (!el) {
      return;
    }
    const head = fromRef.current;
    if (el.currentTime >= head + slot || el.currentTime < head - FITS_SLACK_S) {
      el.currentTime = head;
    }
    setTime(Math.max(0, el.currentTime - head));
  };
  const toggle = () => {
    const el = mediaRef.current;
    if (!el) {
      return;
    }
    if (el.paused) {
      void el.play().catch(() => {});
    }
    else el.pause();
  };

  const media = {
    ref: mediaRef,
    src,
    crossOrigin: MEDIA_CORS as "anonymous",
    preload: "auto" as const,
    muted,
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onTimeUpdate,
    onLoadedMetadata: () => {
      const el = mediaRef.current;
      if (el) {
        el.currentTime = fromRef.current;
      }
    },
  };

  return (
    <>
      <DialogBody>
        <div className="flex flex-col gap-3">
          {/* The transport floats over the picture, as in the viewer. */}
          <div className="group relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-black">
            {asset.type === "video" ? (
              <video
                {...media}
                poster={asset.thumbs?.[0]}
                playsInline
                disablePictureInPicture
                className="size-full object-contain"
                onClick={toggle}
              />
            ) : (
              <>
                <audio {...media} />
                <Peaks peaks={peaks} className="h-1/3 w-4/5 text-white/70" />
              </>
            )}
            <MediaTransport
              playing={playing}
              time={time}
              duration={slot}
              muted={muted}
              onToggle={toggle}
              onSeek={(s) => {
                const el = mediaRef.current;
                if (!el) {
                  return;
                }
                el.currentTime = fromRef.current + s;
                setTime(s);
              }}
              onToggleMute={() => setMuted((m) => !m)}
            />
          </div>
          {/* The stretch the window holds, over the strip it is chosen on. */}
          <div className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatTime(from)} – {formatTime(from + slot)}
          </div>
          <WindowStrip
            asset={asset}
            peaks={peaks}
            slot={slot}
            from={from}
            maxFrom={maxFrom}
            onMove={moveTo}
          />

        </div>
      </DialogBody>
      {/* The actions sit on the card itself: no band of their own. */}
      <div className="flex shrink-0 justify-end gap-2">
        {onBack && (
          <Button variant="outline" onClick={onBack}>
            {t("back")}
          </Button>
        )}
        <Button onClick={() => onConfirm(fromRef.current)}>
          {confirmLabel ?? t("confirm")}
        </Button>
      </div>
    </>
  );
}

/** The narrowest share of the strip the window takes, so a short slot over a
 * long source stays a box to grab. A source too long for that at full view
 * runs wider than the strip and slides under the window. */
const MIN_WINDOW_SHARE = 0.3;

/** How far the window's frame stands out of the strip on each side, px. */
const WINDOW_OUTSET = 4;
/** Room the window keeps from the strip's ends while the film scrolls, px. */
const SCROLL_MARGIN = 24;

/** The source as a filmstrip with the slot's window over it. Dragging the
 * window moves it along the film, and the film scrolls along once the window
 * reaches either end. A source too long for the window to stay a usable
 * width runs wider than the strip, and dragging the film itself slides it
 * under the window, which keeps its place. When the whole source fits, a
 * press beside the window puts the window there instead.
 *
 *   drag the window:  [▒▒▒▒[ window ]→▒▒▒▒▒▒]   the window moves
 *   drag the film:    ←▒▒▒▒[ window ]▒▒▒▒▒▒←    the film moves under it */
function WindowStrip({
  asset,
  peaks,
  slot,
  from,
  maxFrom,
  onMove,
}: {
  asset: MediaAsset;
  peaks?: number[];
  slot: number;
  from: number;
  maxFrom: number;
  onMove: (from: number) => void;
}) {
  const t = useTranslations("timeline.replace");
  const boxRef = useRef<HTMLDivElement>(null);
  const width = useWidth(boxRef);
  const pps =
    width > 0
      ? Math.max(width / asset.duration, (width * MIN_WINDOW_SHARE) / slot)
      : 0;
  const total = asset.duration * pps;
  const winW = slot * pps;

  // The film's offset under the strip. It holds still while the window moves
  // inside the view, and follows only far enough to keep the window in it.
  // Kept as state from the last render, so it only moves when it must.
  const [lastPan, setLastPan] = useState(0);
  const x = from * pps;
  const margin = Math.min(SCROLL_MARGIN, Math.max(0, (width - winW) / 2));
  const kept = Math.min(
    x - margin,
    Math.max(x + winW + margin - width, lastPan),
  );
  const pan = Math.max(0, Math.min(Math.max(0, total - width), kept));
  if (pan !== lastPan) {
    setLastPan(pan);
  }

  const tiles = useStripTiles(asset, total, pps, { lo: pan, hi: pan + width });
  const slides = total > width + 1;
  const grab = useRef<{
    x: number;
    from: number;
    pan: number;
    film: boolean;
  } | null>(null);

  return (
    // The frame stands out of the strip on every side, so the outer box takes
    // the presses and the strip inside it clips only the film.
    <div
      className={cn(
        "relative touch-none select-none",
        slides ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
      )}
      style={{ paddingBlock: WINDOW_OUTSET }}
      onPointerDown={(e) => {
        if (!pps) {
          return;
        }
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);

        // A press inside the window grabs the window. Beside it, a film
        // longer than the strip is grabbed itself; one that fits puts the
        // window's middle under the pointer, and the window is dragged on.
        const box = e.currentTarget.getBoundingClientRect();
        const s = (e.clientX - box.left + pan) / pps;
        const inside = s >= from && s <= from + slot;
        if (!inside && slides) {
          grab.current = { x: e.clientX, from, pan, film: true };
          return;
        }
        const start = inside
          ? from
          : Math.max(0, Math.min(maxFrom, s - slot / 2));
        if (start !== from) {
          onMove(start);
        }
        grab.current = { x: e.clientX, from: start, pan, film: false };
      }}
      onPointerMove={(e) => {
        const g = grab.current;
        if (!g) {
          return;
        }
        const dx = e.clientX - g.x;
        if (!g.film) {
          onMove(g.from + dx / pps);
          return;
        }

        // The film moves with the pointer and the window keeps its place on
        // the strip, so the stretch under it runs the other way. At either
        // end of the film there is nothing more to slide, and the window
        // stays on what it holds.
        const nextPan = Math.max(0, Math.min(total - width, g.pan - dx));
        setLastPan(nextPan);
        onMove(g.from + (nextPan - g.pan) / pps);
      }}
      onPointerUp={() => {
        grab.current = null;
      }}
      onPointerCancel={() => {
        grab.current = null;
      }}
    >
      <div
        ref={boxRef}
        className="relative overflow-hidden rounded-lg bg-black"
        style={{ height: STRIP_H }}
      >
        {asset.type === "video" ? (
          tiles.map((tile) => (
            // eslint-disable-next-line @next/next/no-img-element -- captured frame data URL
            <img
              key={tile.id}
              src={tile.src}
              alt=""
              draggable={false}
              className="absolute top-0 h-full max-w-none object-cover"
              style={{ left: tile.left - pan, width: tile.width }}
            />
          ))
        ) : (
          <Peaks
            peaks={peaks}
            className="absolute inset-y-2 h-[calc(100%-16px)] text-white/70"
            style={{ left: -pan, width: total }}
          />
        )}
        {/* What stays out of the slot dims on both sides of the window. */}
        {pps > 0 && (
          <>
            <div
              className="pointer-events-none absolute inset-y-0 left-0 bg-black/60"
              style={{ width: Math.max(0, from * pps - pan) }}
            />
            <div
              className="pointer-events-none absolute inset-y-0 right-0 bg-black/60"
              style={{ width: Math.max(0, width - (from * pps - pan) - winW) }}
            />
          </>
        )}
      </div>
      {pps > 0 && (
        <div
          role="slider"
          tabIndex={0}
          aria-label={t("window")}
          aria-valuemin={0}
          aria-valuemax={maxFrom}
          aria-valuenow={from}
          aria-valuetext={formatTime(from)}
          className="absolute inset-y-0 cursor-grab rounded-[10px] border-[2.5px] border-[#0a84ff] shadow-[0_0_0_1px_rgba(0,0,0,0.25)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0a84ff]/50"
          style={{
            left: from * pps - pan - WINDOW_OUTSET,
            width: winW + 2 * WINDOW_OUTSET,
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              onMove(from - NUDGE_S);
            }
            else if (e.key === "ArrowRight") onMove(from + NUDGE_S);
            else return;
            e.preventDefault();
          }}
        >
          <span className="absolute top-1.5 left-1.5 rounded-[4px] bg-[#0a84ff] px-1 py-px font-mono text-[10px] text-white tabular-nums">
            {t("seconds", { n: (Math.round(slot * 10) / 10).toFixed(1) })}
          </span>
        </div>
      )}
    </div>
  );
}

/** A box's width, kept current by a ResizeObserver. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry.contentRect.width)),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** The source as filmstrip tiles across `width` px, planned the way the
 * timeline plans a clip's and only over the stretch in `view`. Tiles start
 * from the sampled thumbs, or one head frame when none exist yet, and sharpen
 * as each tile's true frame lands through the edge reader's background lane. */
function useStripTiles(
  asset: MediaAsset,
  width: number,
  pps: number,
  view: { lo: number; hi: number },
) {
  const url = asset.type === "video" ? previewUrl(asset) : null;
  const [gen, bump] = useState(0);
  const head = url && !asset.thumbs?.length ? peekEdgeFrame(url, 0) : null;
  const { lo, hi } = view;

  const tiles = useMemo(() => {
    if (!url || !width) {
      return [];
    }
    const sampled = asset.thumbs?.length && asset.thumbStep;
    const thumbs = sampled ? asset.thumbs! : head ? [head] : [];
    return planFilmstrip({
      thumbs,
      thumbStep: sampled ? asset.thumbStep! : Math.max(1, asset.duration),
      duration: asset.duration,
      aspect: (asset.width ?? 16) / Math.max(1, asset.height ?? 9),
      filmIn: 0,
      w: width,
      pps,
      speed: 1,
      retime: retimeOf({ in: 0, out: asset.duration }),
      tileH: STRIP_H,
      minTileW: STRIP_MIN_TILE,
      cuts: asset.sceneCuts,
      exactFrame: (wantT) => peekEdgeFrame(url, wantT),
      view: { lo, hi },
    });
    // `gen` re-plans as captured frames land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, url, width, pps, head, gen, lo, hi]);

  // Ask once for each tile's true frame, and the head frame a thumbless
  // source seeds its strip with. A read outlives the re-plan the previous one
  // caused, so landing is gated on the step being open, not on this effect.
  const asked = useRef(new Set<string>());
  const open = useRef(true);
  const bumping = useRef(false);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  useEffect(() => {
    if (!url) {
      return;
    }
    // Frames landing together re-plan once, on the next frame.
    const landed = (src: string | null) => {
      if (!src || bumping.current) {
        return;
      }
      bumping.current = true;
      requestAnimationFrame(() => {
        bumping.current = false;
        if (open.current) {
          bump((n) => n + 1);
        }
      });
    };
    if (!asset.thumbs?.length && !head && !asked.current.has("head")) {
      asked.current.add("head");
      void requestEdgeFrame(`replace:strip:head`, url, 0, undefined, {
        background: true,
      }).then(landed);
    }
    for (const tile of tiles) {
      if (tile.exact) {
        continue;
      }
      const key = `${tile.id}:${tile.wantT.toFixed(2)}`;
      if (asked.current.has(key)) {
        continue;
      }
      asked.current.add(key);
      void requestEdgeFrame(
        `replace:strip:${tile.id}`,
        url,
        tile.wantT,
        undefined,
        { background: true },
      ).then(landed);
    }
  }, [url, tiles, asset.thumbs, head]);

  return tiles;
}
