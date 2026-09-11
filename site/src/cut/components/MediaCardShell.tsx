"use client";

import { useRef, type ReactNode, type RefObject } from "react";
import type { AssetRef, AssetRefScope } from "@/cut/lib/assetRef";
import { clearAssetDrag } from "@/cut/lib/assetDrag";
import { useLightbox, type LightboxItem } from "@/cut/lib/lightbox";
import { useRevealFlash } from "@/cut/lib/refReveal";
import { useRefCopy } from "@/cut/lib/refCopy";

/** The card behind every media tile: a Project Files card and a Library card
 * draw their own faces inside it, and this is the one place that says what a
 * card does with the pointer. A click picks it, a double-click opens it in the
 * viewer, a drag carries the pick, hovering plays the clip and leaving puts
 * the rest frame back, ⌘C copies its mention token, and a chat reveal flashes
 * it. */
export function MediaCardShell({
  scope,
  id,
  refs,
  view,
  restTime,
  draggable = true,
  className,
  title,
  onClick,
  onDragStart,
  onHover,
  children,
}: {
  scope: AssetRefScope;
  id: string;
  /** The refs ⌘C copies over the card — the whole pick when the card is in it. */
  refs: () => AssetRef[];
  /** What a double-click opens in the viewer. Unset, the card has nothing to
   * show — a shelf that isn't answering. */
  view?: () => LightboxItem;
  /** The frame the video sits on when the pointer leaves. */
  restTime: number;
  draggable?: boolean;
  className?: string;
  title?: string;
  onClick?: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  /** The pointer has arrived: the card can start what waits for a hover. */
  onHover?: () => void;
  /** The face, given its reveal flash and the ref the tile's video takes so
   * hovering plays it. */
  children: (state: {
    flash: boolean;
    videoRef: RefObject<HTMLVideoElement | null>;
  }) => ReactNode;
}) {
  const { flash, attachReveal } = useRevealFlash(scope, id);
  const videoRef = useRef<HTMLVideoElement>(null);
  const copyRef = useRefCopy(refs);
  return (
    <div
      ref={(el) => {
        attachReveal(el);
        copyRef(el);
      }}
      data-sel-id={id}
      className={className}
      title={title}
      draggable={draggable}
      onClick={onClick}
      onDoubleClick={
        view
          ? (e) => {
              // The + button and the actions menu answer their own clicks; a
              // fast double press on one is two of those, and opens nothing.
              if (
                (e.target as HTMLElement).closest(
                  "button,[role='button'],[role='menuitem']",
                )
              )
                return;
              useLightbox.getState().open(view());
            }
          : undefined
      }
      onDragStart={onDragStart}
      onDragEnd={clearAssetDrag}
      onMouseEnter={() => {
        onHover?.();
        void videoRef.current?.play().catch(() => {});
      }}
      onMouseLeave={() => {
        const v = videoRef.current;
        if (v) {
          v.pause();
          v.currentTime = restTime;
        }
      }}
    >
      {children({ flash, videoRef })}
    </div>
  );
}
