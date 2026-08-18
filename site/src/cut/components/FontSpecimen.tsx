"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SPECIMEN_LINES } from "@/cut/lib/fontSpecimen";
import { linkIdForAsset, onLinkedChanged } from "@/cut/lib/linkedLibrary";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { fontStack, onFontsChanged } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

// A font drawn in itself: the alphabet the way a font file previews anywhere
// else. The library card carries a small one and the lightbox a large one, both
// from here, so the tile and the big view read as the same object.
//
// The picture the shelf baked at upload is what it draws. Live text in the face
// is the standby, and it asks the page to have that face installed.

const LINES = SPECIMEN_LINES;
/** Measured at one size and scaled; large enough that rounding doesn't show. */
const PROBE_PX = 100;

/**
 * The specimen, set to the width it is given.
 *
 * One size for all three lines: the capitals are the widest line, so fitting
 * them sets the size and the rest fall where the face puts them. The size is
 * measured rather than computed because a script face runs three times the
 * width of a grotesque at the same point size.
 */
export function FontSpecimen({
  assetId,
  poster,
  pad = 16,
  className,
}: {
  /** The library asset holding the font file. */
  assetId: string;
  /** The specimen the shelf keeps for this file. */
  poster?: string;
  /** Room left either side of the widest line. */
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
  const family = fontStack(linkIdForAsset(assetId) ?? "");
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    const fit = () => {
      const line = probe.current?.getBoundingClientRect().width;
      const width = box.current?.clientWidth;
      if (!line || !width) return;
      setSize((PROBE_PX * (width - pad)) / line);
    };
    fit();
    // The face arrives after the box does, and the box is resized by the grid.
    const ro = new ResizeObserver(fit);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [family, gen, pad]);
  if (poster && !broken)
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
        className="pointer-events-none invisible fixed top-0 left-0 whitespace-nowrap"
        style={{ fontSize: PROBE_PX }}
      >
        {LINES[0]}
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
