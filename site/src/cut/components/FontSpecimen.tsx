"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isCurrentSpecimen, SPECIMEN_LINES } from "@/cut/lib/fontSpecimen";
import { linkIdForAsset, onLinkedChanged } from "@/cut/lib/linkedLibrary";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { fontStack, hasFont, onFontsChanged } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

// A font drawn in itself. The library card carries a line of it and the big
// view the whole alphabet, both from here, so the two read as the same object.
//
// Live text in the installed face is what it draws. The picture the shelf baked
// at upload is the standby, for a face the page does not have — a shelf that
// did not answer, a listing that has not synced.

/** Measured at one size and scaled; large enough that rounding doesn't show. */
const PROBE_PX = 100;
/** The share of the room a line is allowed to take. Text measures by advance
 * width, and a swash or an italic leans past that, so the fit leaves a little
 * back rather than setting every face flush to the edge. */
const SAFETY = 0.97;

/**
 * The specimen, set to the width it is given.
 *
 * The size is measured rather than computed because a script face runs three
 * times the width of a grotesque at the same point size, and every card in a
 * grid should carry the same weight of line.
 */
export function FontSpecimen({
  assetId,
  poster,
  lines: LINES = SPECIMEN_LINES,
  fitHeight = false,
  pad = 16,
  className,
}: {
  /** The library asset holding the font file. */
  assetId: string;
  /** The specimen the shelf keeps for this file. */
  poster?: string;
  /** What to set in the face. A card takes one line, the big view the whole
   * alphabet. */
  lines?: readonly string[];
  /** The box has a height of its own — a card — so the line is held inside it
   * as well as inside its width. Where the box grows with the text (the big
   * view), width alone sets the size. */
  fitHeight?: boolean;
  /** Room left either side of the widest line, px. */
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
  const family = fontStack(id);
  const installed = hasFont(id);
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    const fit = () => {
      // The probe holds every line, so its width is the widest of them: on
      // most faces that is the capitals, on some the figures.
      const line = probe.current?.getBoundingClientRect().width;
      const width = box.current?.clientWidth;
      const height = box.current?.clientHeight ?? 0;
      if (!line || !width) return;
      // Width sets the size, until the box is short enough that the line would
      // be clipped — a card in a narrow panel column. SAFETY keeps the ends of
      // a line off the edge: a face whose glyphs overhang their advance widths
      // measures narrower than it draws.
      const byWidth = (PROBE_PX * Math.max(0, width - pad * 2) * SAFETY) / line;
      const byHeight =
        fitHeight && height ? (height * SAFETY) / (1.35 * LINES.length) : byWidth;
      setSize(Math.min(byWidth, byHeight));
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
  }, [family, gen, pad, LINES, fitHeight]);
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
      className={cn("grid place-items-center overflow-hidden", className)}
      style={{ fontFamily: family }}
    >
      <span
        ref={probe}
        aria-hidden
        className="pointer-events-none invisible fixed top-0 left-0"
        style={{ fontSize: PROBE_PX }}
      >
        {LINES.map((line) => (
          <span key={line} className="block whitespace-nowrap">
            {line}
          </span>
        ))}
      </span>
      <span
        className="text-center leading-[1.35] whitespace-nowrap"
        style={{ fontSize: size || undefined, opacity: size ? 1 : 0 }}
      >
        {LINES.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </span>
    </div>
  );
}
