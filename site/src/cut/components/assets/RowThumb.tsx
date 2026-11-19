"use client";

import { useEffect, useState } from "react";
import { AudioLines, Film, Image as ImageIcon, Layers } from "lucide-react";
import { useInView } from "@/cut/hooks/useInView";
import { SPECIMEN_BG, SPECIMEN_INK } from "@/cut/lib/fontSpecimen";
import { libraryMediaUrl, libraryPlaybackUrl, libraryPosterUrl, type LibraryAsset } from "@/cut/lib/library";
import { linkIdForAsset, LUT_MARK_ICON, onLinkedChanged } from "@/cut/lib/linkedLibrary";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { fontStack, onFontsChanged } from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import type { AssetEntry } from "./assetsListing";
import { CardPreview } from "./ProjectCard";

// The thumbnail's box. The negative margin lets a 32px picture sit in a row
// sized for one line of text, so file rows and folder rows stay one height.
// `light`: a file looks the same in both themes.
const THUMB = "light relative -my-1.5 grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-muted";
const FILL = "absolute inset-0 size-full object-cover";
const MARK = "size-4 text-muted-foreground/60";

// The audio tile's green and the letters a font row is set in.
const AUDIO_FILL = "#0F6E56";
const FONT_SAMPLE = "Aa";

/** A video file's still: its cover when the import brought one, else the
 * frame the card rests on. The source waits until the row scrolls near. */
function VideoThumb({ asset: a }: { asset: LibraryAsset }) {
  const [ref, seen] = useInView<HTMLSpanElement>();
  const poster = libraryPosterUrl(a);
  const restT = Math.min(1, Math.max(0.1, (a.duration || 2) / 10));

  return (
    <span ref={ref} className={THUMB}>
      <Film className={MARK} />
      {seen && poster && (
        // eslint-disable-next-line @next/next/no-img-element -- library media file, not Next-optimizable
        <img crossOrigin={MEDIA_CORS} src={poster} alt="" draggable={false} className={FILL} />
      )}
      {seen && !poster && (
        <video
          crossOrigin={MEDIA_CORS}
          src={`${libraryPlaybackUrl(a)}#t=${restT}`}
          muted
          playsInline
          preload="metadata"
          className={FILL}
        />
      )}
    </span>
  );
}

/** A font file's mark: two letters set in the face on the specimen sheet. */
function FontThumb({ assetId }: { assetId: string }) {
  // The face registers after the listing lands; redraw when it does.
  const [, bump] = useState(0);
  useEffect(() => onFontsChanged(() => bump((n) => n + 1)), []);
  useEffect(() => onLinkedChanged(() => bump((n) => n + 1)), []);

  return (
    <span
      className={cn(THUMB, "text-[15px] leading-none")}
      style={{ backgroundColor: SPECIMEN_BG, color: SPECIMEN_INK, fontFamily: fontStack(linkIdForAsset(assetId) ?? "") }}
      aria-hidden
    >
      {FONT_SAMPLE}
    </span>
  );
}

/** A library file's thumbnail by type. */
function MediaThumb({ asset: a, offline }: { asset: LibraryAsset; offline: boolean }) {
  if (a.type === "audio") {
    return (
      <span className={THUMB} style={{ backgroundColor: AUDIO_FILL }}>
        <AudioLines className="size-4 text-white" />
      </span>
    );
  }

  if (a.type === "font") {
    return <FontThumb assetId={a.id} />;
  }

  if (a.type === "lut") {
    return (
      <span className={cn(THUMB, "bg-background")}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static icon */}
        <img src={LUT_MARK_ICON} alt="" aria-hidden className="size-6 object-contain" />
      </span>
    );
  }

  // A shelf that isn't answering has no picture to load.
  if (offline) {
    const Mark = a.type === "image" ? ImageIcon : Film;
    return (
      <span className={THUMB}>
        <Mark className={MARK} />
      </span>
    );
  }

  if (a.type === "video") {
    return <VideoThumb asset={a} />;
  }

  return (
    <span className={THUMB}>
      <ImageIcon className={MARK} />
      {/* eslint-disable-next-line @next/next/no-img-element -- library media file, not Next-optimizable */}
      <img
        crossOrigin={MEDIA_CORS}
        src={libraryMediaUrl(a.fileName, a.residency)}
        alt=""
        loading="lazy"
        draggable={false}
        className={FILL}
      />
    </span>
  );
}

/** The picture at the head of an Assets list row: the project's opening
 * frame, a video's still, the image itself, or the mark its tile wears. */
export function RowThumb({ entry: e, offline }: { entry: AssetEntry; offline: boolean }) {
  if (e.kind === "project") {
    return (
      <span className={THUMB}>
        <CardPreview project={e.project} residency={e.residency} offline={offline} />
      </span>
    );
  }

  if (e.kind === "template") {
    return (
      <span className={THUMB}>
        <Layers className="size-4 text-violet-500" />
      </span>
    );
  }

  return <MediaThumb asset={e.asset} offline={offline} />;
}
