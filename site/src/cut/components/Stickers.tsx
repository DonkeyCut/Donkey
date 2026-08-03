"use client";

import { useCallback, useMemo, useState } from "react";
import { Copy, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { clearAssetDrag, setAssetDragData } from "@/cut/lib/assetDrag";
import { PICKED_RING, useAssetPick } from "@/cut/lib/assetPick";
import {
  addRefOnce,
  collectRefs,
  mentionToken,
  sameRef,
  upsertRef,
  useAssetDrop,
  useRefCandidates,
  type AssetRef,
} from "@/cut/lib/assetRef";
import { signInUrl, useSignedIn } from "@/cut/lib/generate";
import { isLottieAsset } from "@/cut/lib/lottieAssets";
import { refsFromDroppedFiles } from "@/cut/lib/refMedia";
import { createCustomSticker, type StickerStage } from "@/cut/lib/stickerCreate";
import { useEditor } from "@/cut/lib/store";
import type { MediaAsset } from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { CopyHandlePill, MentionTextarea, RefChips } from "./AssetRefs";
import { GeneratedAssetMenu } from "./GeneratedAssetMenu";
import { DictationControl } from "./MicDictation";
import { HostedErrorText } from "./hostedError";

/**
 * The project's sticker images — generated cutouts, all tagged origin
 * "sticker" so they live in the Elements panel and never in Media. The pieces
 * here are what that panel's Stickers category is built from: the list, the
 * tile, and the generate composer.
 */
export function useProjectStickers(): {
  stickers: MediaAsset[];
  /** The @name a prompt would reach a sticker by, for its tile's copy pill. */
  handleOf: (id: string) => string | undefined;
} {
  // Select the array itself and narrow outside the selector: a `filter` inside
  // returns a fresh array every read, which the store's snapshot check reads
  // as a change on every render.
  const assets = useEditor((s) => s.assets);
  const stickers = useMemo(() => assets.filter((a) => a.origin === "sticker"), [assets]);
  const candidates = useRefCandidates();
  return {
    stickers,
    handleOf: (id) => candidates.find((c) => c.scope === "project" && c.id === id)?.handle,
  };
}

/** A hover button in the tile's top-right corner, as the generated-image tiles
 * wear them. */
const ROUND_ACTION =
  "grid size-5 place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/65";

/** One sticker: click picks it, the hover buttons act on it, and it drags into
 * any composer as a reference. The picking, the @tag and the drag are the same
 * as the Image and Video tabs — see `assetPick.ts`. */
export function StickerTile({
  asset: a,
  projectId,
  handle,
  readOnly,
}: {
  asset: MediaAsset;
  projectId: string;
  handle?: string;
  readOnly: boolean;
}) {
  const { picked, pick } = useAssetPick(a.id);
  const lottie = isLottieAsset(a);
  return (
    <div className={cn("group relative rounded-lg", picked && PICKED_RING)}>
      <button
        title={a.name}
        data-pick-id={a.id}
        className="block w-full overflow-hidden rounded-lg bg-muted outline-none"
        draggable
        onDragStart={(e) => {
          setAssetDragData(e, a.id);
          // The tile is the ghost, so it keeps its corner radius instead of
          // the browser's square white frame.
          const r = e.currentTarget.getBoundingClientRect();
          e.dataTransfer.setDragImage(e.currentTarget, e.clientX - r.left, e.clientY - r.top);
        }}
        onDragEnd={clearAssetDrag}
        onClick={pick}
      >
        {lottie ? (
          <span className="grid aspect-square w-full place-items-center p-1 text-center">
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold text-muted-foreground">Lottie</span>
              <span className="block truncate text-[10px]" title={a.name}>
                {a.name.replace(/\.json$/i, "")}
              </span>
            </span>
          </span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- project media URL
          <img
            src={a.url}
            alt={a.name}
            loading="lazy"
            className="aspect-square w-full object-contain p-1 transition-transform group-hover:scale-[1.06]"
          />
        )}
      </button>
      {/* The handle and the actions share one row, so the pill's taller box
          can't sit off the buttons' center across the tile. */}
      <div className="pointer-events-none absolute inset-x-1 top-1 flex items-center justify-between gap-1">
        <CopyHandlePill handle={handle} name={a.name} className="pointer-events-auto static min-w-0" />
        {!readOnly && (
          <div className="pointer-events-auto flex shrink-0 items-center gap-1">
            <button
              title="Add to timeline"
              aria-label={`Add ${a.name}`}
              className={ROUND_ACTION}
              onClick={() =>
                useEditor
                  .getState()
                  .addSticker(lottie ? { assetId: a.id, lottie: true } : { assetId: a.id })
              }
            >
              <Plus className="size-3" />
            </button>
            <GeneratedAssetMenu
              asset={a}
              projectId={projectId}
              triggerClassName={cn(ROUND_ACTION, "data-popup-open:opacity-100")}
              before={
                <DropdownMenuItem
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(handle ? `@${handle}` : mentionToken(a.name))
                      .catch(() => {})
                  }
                >
                  <Copy /> Copy reference
                </DropdownMenuItem>
              }
              after={
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => useEditor.getState().removeAsset(a.id)}
                >
                  <Trash2 /> Delete
                </DropdownMenuItem>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

const STAGE_LABEL: Record<StickerStage, string> = {
  generating: "Drawing…",
  cutting: "Cutting out…",
  saving: "Saving…",
};

/**
 * "Create a sticker": prompt → hosted image generation → background removal
 * (the plain-backdrop knockout first, then matting) → white die-cut outline →
 * saved as an origin-"sticker" asset and dropped on the timeline. The composer
 * is the generate-image one: same box, same dictation, same full-width button,
 * so the two read as one way of asking for a picture.
 */
export function CreateSticker({ projectId }: { projectId: string }) {
  const [prompt, setPrompt] = useState("");
  const [refs, setRefs] = useState<AssetRef[]>([]);
  const [stage, setStage] = useState<StickerStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = useSignedIn();
  const candidates = useRefCandidates();
  const busy = stage !== null;

  const addRef = useCallback((ref: AssetRef) => setRefs((rs) => addRefOnce(rs, ref)), []);
  const updateRef = useCallback((ref: AssetRef) => setRefs((rs) => upsertRef(rs, ref)), []);
  const removeRef = useCallback(
    (ref: AssetRef) => setRefs((rs) => rs.filter((r) => !sameRef(r, ref))),
    []
  );
  // OS files handed to the composer — dropped on it or pasted into the prompt —
  // attach as references; media files import into the project on the way.
  const attachFiles = useCallback(
    (files: File[]) =>
      void refsFromDroppedFiles(projectId, files).then((next) => next.forEach(addRef)),
    [projectId, addRef]
  );
  const { active: dropActive, attachTarget, targetProps } = useAssetDrop(addRef, attachFiles);

  const create = async () => {
    const { text, refs: all } = collectRefs(prompt.trim(), refs, candidates);
    if (!text || busy) return;
    setError(null);
    try {
      const asset = await createCustomSticker(projectId, text, setStage, { refs: all });
      useEditor.getState().addSticker({ assetId: asset.id });
      setPrompt("");
      setRefs([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the sticker.");
    } finally {
      setStage(null);
    }
  };

  return (
    <div
      ref={attachTarget}
      {...targetProps}
      className="relative flex shrink-0 flex-col gap-3"
    >
      {/* The generate-image composer: references ride as thumbnails inside the
          box, above the prompt, and @name reaches anything in the project. */}
      <div
        className={cn(
          "relative flex shrink-0 flex-col rounded-lg border border-input focus-within:border-ring",
          dropActive && "border-[#0a84ff] ring-2 ring-[#0a84ff]/30 ring-inset"
        )}
      >
        <RefChips
          refs={refs}
          onRemove={removeRef}
          onUpdate={updateRef}
          className="p-2 pb-0"
          peekSide="bottom"
        />
        <MentionTextarea
          className="min-h-[100px] w-full resize-y bg-transparent px-2.5 py-2 pr-9 text-[12.5px] leading-relaxed outline-none"
          placeholder="A corgi in sunglasses… Drop an image in or type @ to reference one."
          value={prompt}
          onChange={setPrompt}
          candidates={candidates}
          submitKey="mod-enter"
          menuSide="bottom"
          onSubmit={() => void create()}
          attachedRefs={refs}
          onUpsertRef={updateRef}
          onPasteFiles={attachFiles}
          onRemoveLastRef={() => {
            const last = refs[refs.length - 1];
            if (last) removeRef(last);
          }}
        />
        <DictationControl
          text={prompt}
          onResult={setPrompt}
          buttonClassName="absolute right-2 bottom-2 bg-background/70 backdrop-blur-sm"
        />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          className="min-w-0 flex-1"
          disabled={!prompt.trim() || busy || signedIn === false}
          onClick={() => void create()}
        >
          {stage ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <Sparkles data-icon="inline-start" />
          )}
          {stage ? STAGE_LABEL[stage] : "Create sticker"}
        </Button>
      </div>

      {signedIn === false && (
        <p className="shrink-0 text-[11px] leading-relaxed text-muted-foreground">
          Generating runs on your Donkey account.{" "}
          <a className="font-medium text-blue-600 hover:underline dark:text-blue-400" href={signInUrl()}>
            Sign in
          </a>{" "}
          to continue.
        </p>
      )}

      {error && (
        <div className="shrink-0 text-[10.5px] leading-snug break-words text-red-600">
          <HostedErrorText error={error} />
        </div>
      )}
    </div>
  );
}
