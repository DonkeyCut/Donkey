"use client";

import { type RefObject } from "react";
import { LUT_FILE_ICON } from "@/cut/lib/linkedLibrary/luts";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { formatTime } from "@/cut/lib/time";
import type { MediaAsset } from "@/cut/lib/types";
import { AudioCardFace } from "./AudioPanel";

/** What a project file's square tile shows: a video on its first frame (it
 * plays when the tile's hover handlers start it), an image, a LUT's icon, or
 * the audio card face, with a video's length in the corner. Project Files and
 * the Replace picker draw their tiles with it, so a file looks the same in
 * both. The video's source waits for `seen`, so a long grid opens only what
 * has been scrolled near. */
export function AssetTileFace({
  asset,
  videoRef,
  seen,
}: {
  asset: MediaAsset;
  videoRef: RefObject<HTMLVideoElement | null>;
  seen: boolean;
}) {
  return (
    <>
      {asset.type === "video" ? (
        // Native first frame as the poster — full-resolution, no blurry thumb.
        seen && (
          <video crossOrigin={MEDIA_CORS}
            ref={videoRef}
            src={`${asset.url}#t=0.1`}
            poster={asset.thumbs?.[0]}
            preload="metadata"
            muted
            loop
            playsInline
            className="size-full object-cover"
          />
        )
      ) : asset.type === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element -- engine/static file, not Next-optimizable
        <img crossOrigin={MEDIA_CORS} src={asset.url} alt={asset.name} loading="lazy" className="size-full object-cover" />
      ) : asset.type === "lut" ? (
        // eslint-disable-next-line @next/next/no-img-element -- static icon
        <img src={LUT_FILE_ICON} alt={asset.name} className="size-full object-contain p-2" />
      ) : (
        <AudioCardFace
          url={asset.url}
          duration={asset.duration}
          peaks={asset.peaks}
        />
      )}
      {asset.type === "video" && (
        <span
          data-drag-omit
          className="absolute right-1 bottom-1 rounded-[5px] bg-black/65 px-1 py-px font-mono text-[9.5px] text-white tabular-nums"
        >
          {formatTime(asset.duration)}
        </span>
      )}
    </>
  );
}
