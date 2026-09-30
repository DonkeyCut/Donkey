"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { isCurrentSpecimen, SPECIMEN_TEXT } from "@/cut/lib/fontSpecimen";
import { linkIdForAsset, onLinkedChanged } from "@/cut/lib/linkedLibrary";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { fontStack, hasFont, onFontsChanged } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

// A font drawn in itself. The library card and the big view both set the
// pangram from here, wrapped and left-aligned, so the two read as the same
// object at two sizes.
//
// Live text in the installed face is what it draws, and only that face: the
// picture the shelf baked at upload stands in for a face the page does not have
// — a shelf that did not answer, a listing that has not synced — and is set the
// same way. With neither, the sheet stays blank.

/** The share of the room the words are allowed to take. Text measures by
 * advance width, and a swash or an italic leans past that, so the fit leaves a
 * little back rather than setting every face flush to the edge. */
const SAFETY = 0.97;

/**
 * The specimen, wrapped to fill the box it is given.
 *
 * The size is measured rather than computed because a script face runs three
 * times the width of a grotesque at the same point size, and every card in a
 * grid should carry the same weight of type: the largest size at which no word
 * is wider than the box and the lines fit its height.
 */
export function FontSpecimen({
  assetId,
  src,
  poster,
  pad = 16,
  className,
}: {
  /** The library asset holding the font file. */
  assetId: string;
  /** A protected font URL for a viewer outside the signed-in library. */
  src?: string;
  /** The specimen the shelf keeps for this file. */
  poster?: string;
  /** Room left either side of the words, px. */
  pad?: number;
  className?: string;
}) {
  const [gen, bump] = useState(0);
  const [broken, setBroken] = useState(false);
  const again = () => bump((n) => n + 1);
  // The shelf listing says which font this is; the registry says what that font
  // draws in. Both land after the first paint.
  useEffect(() => onFontsChanged(again), []);
  useEffect(() => onLinkedChanged(again), []);
  const id = linkIdForAsset(assetId) ?? "";
  const localId = useId();
  const [loadedFont, setLoadedFont] = useState<{ src: string; family: string } | null>(null);
  const registered = hasFont(id);
  useEffect(() => {
    // The card loads its own file when the shelf's sync has not installed the
    // face yet, so it never waits on the listing.
    if (!src || registered) return;
    let live = true;
    const face = new FontFace(`shared-${localId}`, `url(${JSON.stringify(src)})`);
    void face.load().then(() => {
      if (!live) return;
      document.fonts.add(face);
      setLoadedFont({ src, family: face.family });
    }).catch(() => {});
    return () => { live = false; document.fonts.delete(face); };
  }, [src, localId, registered]);
  const localFamily = loadedFont?.src === src ? loadedFont?.family : undefined;
  const family = registered ? fontStack(id) : localFamily ? JSON.stringify(localFamily) : fontStack(id);
  const installed = registered || !!localFamily;
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    const fit = () => {
      const measure = probe.current;
      const width = box.current?.clientWidth;
      const height = box.current?.clientHeight;
      if (!measure || !width || !height) return;
      const room = Math.max(0, width - pad * 2) * SAFETY;
      measure.style.width = `${room}px`;
      let lo = 4;
      let hi = 400;
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        measure.style.fontSize = `${mid}px`;
        if (measure.scrollWidth <= room + 0.5 && measure.scrollHeight <= height * SAFETY) lo = mid;
        else hi = mid;
      }
      setSize(lo);
    };
    fit();
    // The face arrives after the box does, and the box is resized by the grid.
    const ro = new ResizeObserver(fit);
    if (box.current) ro.observe(box.current);
    // A face measured before it loaded is measured in the fallback, which is
    // narrower than a display face and sets a size the real one overflows.
    // Both signals are needed: `ready` for a face already in flight, the event
    // for one that starts loading after this ran.
    const fonts = document.fonts;
    void fonts?.ready.then(fit).catch(() => {});
    fonts?.addEventListener?.("loadingdone", fit);
    return () => {
      ro.disconnect();
      fonts?.removeEventListener?.("loadingdone", fit);
    };
  }, [family, gen, pad]);
  if (poster && isCurrentSpecimen(poster) && !broken && !installed)
    return (
      // eslint-disable-next-line @next/next/no-img-element -- library media file, not Next-optimizable
      <img
        crossOrigin={MEDIA_CORS}
        src={poster}
        alt=""
        className={cn("object-contain", className)}
        onError={() => setBroken(true)}
      />
    );

  return (
    <div
      ref={box}
      className={cn("relative grid items-center overflow-hidden", className)}
      style={{ fontFamily: family }}
    >
      <span
        ref={probe}
        aria-hidden
        className="pointer-events-none invisible fixed top-0 left-0 leading-[1.2]"
      >
        {SPECIMEN_TEXT}
      </span>
      <span
        className="leading-[1.2]"
        // Words set in a stand-in face say nothing about the font, so the
        // sheet stays blank until the face itself is in.
        style={{ fontSize: size || undefined, opacity: size && installed ? 1 : 0, paddingInline: pad }}
      >
        {SPECIMEN_TEXT}
      </span>
      {!installed && (
        // Lines of type-shaped shimmer while the face loads.
        <span aria-hidden className="absolute inset-0 flex flex-col justify-center gap-[9%]" style={{ paddingInline: pad }}>
          {["88%", "72%", "46%"].map((w) => (
            <span key={w} className="h-[12%] animate-pulse rounded-md bg-white/10" style={{ width: w }} />
          ))}
        </span>
      )}
    </div>
  );
}
