import { create } from "zustand";
import { isLottieAsset } from "./lottieAssets";
import { mediaOfRef, mediaTypeOfRef, placeRefAtPlayhead } from "./refPlace";
import { refFromAsset, type AssetRef } from "./assetRef";
import type { LibraryData } from "./library";
import {
  canAdjust,
  overlayTakesMedia,
  selectedTarget,
  targetTakes,
  type ReplaceTarget,
} from "./replaceItem";
import { reportSwallowed } from "./report";
import { useEditor } from "./store";
import { clipLen } from "./timelineEnd";
import type { TimelineClipboardItem } from "./itemKinds";
import type { MediaAsset } from "./types";

/**
 * The replace flow behind the Replace popover and the paste onto a selected
 * item: which item the popover is open on, and the swap itself through the
 * store's replace actions.
 */

/** What the Replace popover is doing to the item: swapping its media for another
 * file, or choosing another part of the file it already plays. */
type Mode = "replace" | "adjust";

export const useReplaceTarget = create<{ target: ReplaceTarget | null; mode: Mode }>(() => ({
  target: null,
  mode: "replace",
}));

/** Open the Replace dialog on an item. */
export function openReplace(target: ReplaceTarget) {
  useReplaceTarget.setState({ target, mode: "replace" });
}

/** Open the same popover on a clip's own file, to choose which part of it
 * plays. The clip keeps its place and its length. */
export function openAdjust(target: ReplaceTarget) {
  useReplaceTarget.setState({ target, mode: "adjust" });
}

export const closeReplace = () => useReplaceTarget.setState({ target: null });

/** The length the item holds on the timeline, seconds; null once it is gone. */
export function slotOf(target: ReplaceTarget): number | null {
  const s = useEditor.getState();
  if (target.kind === "clip") {
    const clip = s.clips.find((c) => c.id === target.id);
    return clip ? clipLen(clip) : null;
  }
  if (target.kind === "audio") {
    const a = s.audioClips.find((x) => x.id === target.id);
    return a ? a.out - a.in : null;
  }
  const o = s.overlays.find((x) => x.id === target.id);
  return o && overlayTakesMedia(o) ? o.end - o.start : null;
}

/** The asset the item plays now, so the picker leaves it out. */
export function currentAssetOf(target: ReplaceTarget): string | undefined {
  const s = useEditor.getState();
  if (target.kind === "clip") {
    return s.clips.find((c) => c.id === target.id)?.assetId;
  }
  if (target.kind === "audio") {
    return s.audioClips.find((a) => a.id === target.id)?.assetId;
  }
  const o = s.overlays.find((x) => x.id === target.id);
  return o?.kind === "sticker" ? o.assetId : undefined;
}

/** Swap the media in through the store's own replace actions. */
export function commitReplace(target: ReplaceTarget, asset: MediaAsset, from: number): ReplaceTarget | null {
  const s = useEditor.getState();
  if (target.kind === "clip") {
    s.replaceClipAsset(target.id, asset.id, { from });
    return target;
  }
  if (target.kind === "audio") {
    s.replaceAudioAsset(target.id, asset.id, from);
    return target;
  }

  // A sticker shows another still in place; footage, or anything on a shape,
  // becomes a clip framed to the element's box.
  const o = s.overlays.find((x) => x.id === target.id);
  if (o?.kind === "sticker" && asset.type === "image") {
    s.replaceSticker(target.id, asset.id);
    return target;
  }
  const id = s.overlayToClip(target.id, asset.id, from);
  return id ? { kind: "clip", id } : null;
}

/**
 * A paste onto the selected item: the pasted file takes the item's place on
 * the timeline, playing from `from` for the item's length, and when the file
 * runs longer than that the adjuster opens on it to choose the part. False
 * when the item is gone, cannot take the file, or already plays it, so the
 * paste lands the usual way: ⌘V again on the copy a paste just selected adds
 * another copy.
 */
export function replaceWithPasted(target: ReplaceTarget, asset: MediaAsset, from = 0): boolean {
  const s = useEditor.getState();
  if (s.readOnly || slotOf(target) === null || !targetTakes(target, asset.type)) {
    return false;
  }
  if (isLottieAsset(asset) && !isStickerTarget(target)) {
    return false;
  }
  if (currentAssetOf(target) === asset.id) {
    return false;
  }
  const placed = commitReplace(target, asset, from);
  if (!placed || placed.kind === "overlay") {
    return true;
  }

  // The part to play is chosen right away when there is more than one.
  const after = useEditor.getState();
  const clip =
    placed.kind === "clip"
      ? after.clips.find((c) => c.id === placed.id)
      : after.audioClips.find((c) => c.id === placed.id);
  if (clip && canAdjust(asset, clip)) {
    openAdjust(placed);
  }
  return true;
}

/** The pasted file onto the selected item, or under the indicator at `at`
 * when the item cannot take it, the way its card's add action lands it: a
 * sticker as a sticker element. */
export async function replaceOrPlace(
  target: ReplaceTarget,
  asset: MediaAsset,
  ctx: { projectId: string; library: LibraryData; at: number },
  from = 0
): Promise<void> {
  if (replaceWithPasted(target, asset, from)) {
    return;
  }
  await placeRefAtPlayhead(refFromAsset(asset), ctx);
}

/** Whether the item is a sticker, which alone can show an animated one. */
export function isStickerTarget(target: ReplaceTarget): boolean {
  if (target.kind !== "overlay") {
    return false;
  }
  return (
    useEditor.getState().overlays.find((o) => o.id === target.id)?.kind ===
    "sticker"
  );
}

/**
 * Paste copied cards at the timeline. One card onto the selected item that
 * takes its kind replaces it (a sound effect onto a sound clip, footage onto a
 * clip), copied into the project first when it lives on the shelf or in
 * stock; anything else lands under the indicator at `at`.
 */
export async function pasteRefs(
  refs: AssetRef[],
  ctx: { projectId: string; library: LibraryData; at: number }
): Promise<void> {
  // The selection at the keystroke: the import below may outlast a click.
  const target = selectedTarget(useEditor.getState());
  const one = refs.length === 1 ? refs[0] : null;
  if (target && one && targetTakes(target, mediaTypeOfRef(one, ctx.library))) {
    const asset = await mediaOfRef(one, ctx);
    if (!asset || useEditor.getState().projectId !== ctx.projectId) {
      return;
    }
    await replaceOrPlace(target, asset, ctx);
    return;
  }

  // Several cards, or nothing selected that takes one: each lands in copy
  // order, the way its tile's add action lands it.
  for (const ref of refs) {
    try {
      await placeRefAtPlayhead(ref, ctx);
    } catch (err) {
      reportSwallowed("[cut] paste failed", err, ref.name);
    }
  }
}

/** The file a copied timeline item plays and the second it starts at: one
 * clip, sound clip or sticker copied on its own. Null for anything else. */
export function copiedMedia(items: TimelineClipboardItem[]): { assetId: string; from: number } | null {
  if (items.length !== 1) {
    return null;
  }
  const cb = items[0];
  if (cb.kind === "clip" || cb.kind === "audio") {
    return { assetId: cb.item.assetId, from: cb.item.in };
  }
  if (cb.kind === "overlay" && cb.item.kind === "sticker" && cb.item.assetId) {
    return { assetId: cb.item.assetId, from: 0 };
  }
  return null;
}

/**
 * A copied timeline item pasted onto the selected item: when the copy plays a
 * file the item takes, that file replaces the item where it stands, from the
 * second the copy started at. False when it does not apply, so the paste
 * lands the copy the usual way.
 *
 *     copy a 2 s clip of beach.mp4 from 4 s, select a 3 s clip, ⌘V
 *     → the selected clip plays beach.mp4 from 4 s for its own 3 s
 */
export function pasteItemOnto(target: ReplaceTarget, items: TimelineClipboardItem[]): boolean {
  // An item pasted with itself still selected is the copy-and-paste
  // duplicate, and lands as one.
  const media = copiedMedia(items);
  if (!media || items[0].item.id === target.id) {
    return false;
  }
  const asset = useEditor.getState().assets.find((a) => a.id === media.assetId);
  if (!asset || !targetTakes(target, asset.type)) {
    return false;
  }
  return replaceWithPasted(target, asset, media.from);
}
