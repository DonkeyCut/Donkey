"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, FileText, Loader2, Music, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { addLibraryAssetToProject, fetchLibrary } from "@/cut/lib/library";
import { useLightbox, type LightboxItem } from "@/cut/lib/lightbox";
import { importImage, importStockVideo } from "@/cut/lib/media";
import { usePreviewAudio } from "@/cut/lib/previewAudio";
import { useEditor } from "@/cut/lib/store";
import { DocText, useDocText } from "./DocText";
import { FontSpecimen } from "./FontSpecimen";
import {
  SPECIMEN_ALPHABET,
  SPECIMEN_BG,
  SPECIMEN_INK,
} from "@/cut/lib/fontSpecimen";
import { PeakStrip } from "./AudioPanel";
import { MediaTransport } from "./MediaTransport";
import { cn } from "@/lib/utils";

// The asset lightbox: the big version of a stock, generated, or chat asset
// floating straight on the backdrop — media on top, name and prompt below,
// plus a button to drop it onto the timeline. Mounted once in the editor and
// once on the library page, which opens it bare — media alone.
// Video and images size the dialog from a known aspect before the media
// loads; audio gets a waveform player and text files render formatted
// (markdown, CSV table, plain text).

export function Lightbox() {
  const item = useLightbox((s) => s.item);
  const [adding, setAdding] = useState(false);
  // Keyed to the added item's src, so opening a different item clears the
  // "Added" confirmation without a reset effect.
  const [addedSrc, setAddedSrc] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Escape closes the lightbox.
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useLightbox.getState().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item]);

  if (!item) return null;

  const added = addedSrc === item.src;

  const add = async () => {
    const projectId = useEditor.getState().projectId;
    if (!projectId) return;
    setAdding(true);
    try {
      if (item.assetId) {
        useEditor.getState().addAssetAtPlayhead(item.assetId);
      } else if (item.libraryId) {
        // Library media copies in through the library route, like using it
        // from the Library panel.
        const lib = (await fetchLibrary()).assets.find(
          (a) => a.id === item.libraryId,
        );
        if (!lib) throw new Error("Library asset not found.");
        await addLibraryAssetToProject(projectId, lib);
      } else {
        // A stock clip imports as footage; a stock image bakes into a still.
        const asset =
          item.kind === "video"
            ? await importStockVideo(projectId, {
                url: item.src,
                name: item.name,
              })
            : await importImage(projectId, { url: item.src, name: item.name });
        useEditor.getState().addAssetAtPlayhead(asset.id);
      }
      setAddedSrc(item.src);
    } catch {
      // Leave the button enabled so the user can retry.
    } finally {
      setAdding(false);
    }
  };

  // Text never rides the timeline; audio needs a project or library home to
  // land from.
  const canAdd =
    !item.bare &&
    item.kind !== "text" &&
    item.kind !== "font" &&
    (item.kind !== "audio" ||
      item.assetId !== null ||
      item.libraryId !== undefined);

  // With a known aspect the dialog width follows it — capped so the media
  // stays within 68vh tall and 860px/92vw wide — and the media box carries the
  // same ratio, so nothing shifts when the file loads. Audio and text use
  // fixed reading widths instead.
  const ratio = item.ratio;
  const width =
    item.kind === "audio"
      ? "min(92vw, 480px)"
      : item.kind === "font"
        ? "min(92vw, 1000px)"
        : item.kind === "text"
          ? "min(92vw, 720px)"
          : ratio
            ? `min(92vw, 860px, ${Math.round(68 * ratio * 100) / 100}vh)`
            : "min(92vw, 860px)";

  return (
    <div
      className="fixed inset-0 z-70 grid place-items-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={() => useLightbox.getState().close()}
    >
      <div
        className="relative flex max-h-[92vh] flex-col gap-3"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          title="Close"
          className="absolute top-3 right-3 z-10 grid size-8 place-items-center rounded-full bg-black/45 text-white hover:bg-black/65"
          onClick={() => useLightbox.getState().close()}
        >
          <X className="size-4" />
        </button>

        <LightboxMedia item={item} ratio={ratio} />

        {!item.bare && (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-[15px] leading-snug font-semibold tracking-tight break-words text-white">
                {item.name}
              </div>
              {canAdd && (
                <Button className="shrink-0" disabled={adding} onClick={add}>
                  {adding ? (
                    <Loader2
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : added ? (
                    <Check data-icon="inline-start" />
                  ) : (
                    <Plus data-icon="inline-start" />
                  )}
                  {added ? "Added" : "Use"}
                </Button>
              )}
            </div>

            {item.prompt && item.prompt !== item.name && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold tracking-wide text-white/60 uppercase">
                    Prompt
                  </span>
                  <button
                    title="Copy prompt"
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(item.prompt)
                        .then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        });
                    }}
                  >
                    {copied ? (
                      <Check className="size-3 text-emerald-400" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="rounded-lg bg-white/10 px-3 py-2 text-[12.5px] leading-relaxed text-white/90">
                  {item.prompt}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LightboxMedia({
  item,
  ratio,
}: {
  item: LightboxItem;
  ratio?: number;
}) {
  if (item.kind === "audio") return <AudioBody item={item} />;
  if (item.kind === "text") return <TextBody item={item} />;
  if (item.kind === "font") return <FontBody item={item} />;

  const mediaClass = ratio
    ? "block w-full rounded-2xl bg-black object-cover shadow-2xl"
    : "block max-h-[68vh] w-full rounded-2xl bg-black object-contain shadow-2xl";
  const mediaStyle = ratio ? { aspectRatio: ratio } : undefined;

  if (item.kind === "video") {
    return <VideoBody item={item} ratio={ratio} style={mediaStyle} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static/project image, client-only page
    <img
      crossOrigin={MEDIA_CORS}
      src={item.src}
      alt={item.name}
      className={mediaClass}
      style={mediaStyle}
    />
  );
}

/** The big video: the picture with the app's own transport floating on it,
 * revealed on hover and held up while it is paused. */
function VideoBody({
  item,
  ratio,
  style,
}: {
  item: LightboxItem;
  ratio?: number;
  style?: { aspectRatio: number };
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Playing is what the element reports, never what was asked of it: an
  // autoplay the browser blocks fires no `pause`, and a transport that
  // assumed it started would hide itself behind a Pause icon over a still
  // picture. The `play` event turns it on.
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(item.duration ?? 0);
  const [muted, setMuted] = useState(false);

  const toggle = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl bg-black shadow-2xl",
        ratio ? "w-full" : "max-h-[68vh] w-full"
      )}
      style={style}
    >
      <video
        ref={videoRef}
        crossOrigin={MEDIA_CORS}
        autoPlay
        loop
        playsInline
        muted={muted}
        // The browser's own control bar carries chrome of its own — download,
        // playback speed, picture-in-picture — so the lightbox draws the
        // transport itself and keeps picture-in-picture out of the context menu.
        disablePictureInPicture
        poster={item.poster}
        src={item.src}
        className={cn(
          "block w-full",
          ratio ? "size-full object-cover" : "max-h-[68vh] object-contain"
        )}
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(loadedDuration(e.currentTarget, item))}
      />
      <MediaTransport
        playing={playing}
        time={time}
        duration={duration}
        muted={muted}
        onToggle={toggle}
        onSeek={(t) => {
          const el = videoRef.current;
          if (!el) return;
          el.currentTime = t;
          setTime(t);
        }}
        onToggleMute={() => setMuted((m) => !m)}
      />
    </div>
  );
}

/** The length the transport runs on once the file's metadata is in: what the
 * element reports, unless it reports nothing usable — a source streamed
 * without a length says Infinity — in which case the catalog's figure stands. */
function loadedDuration(el: HTMLMediaElement, item: LightboxItem) {
  return Number.isFinite(el.duration) && el.duration > 0
    ? el.duration
    : (item.duration ?? 0);
}

function AudioBody({ item }: { item: LightboxItem }) {
  const asset = useEditor((s) =>
    item.assetId ? s.assets.find((a) => a.id === item.assetId) : undefined,
  );
  const audioEl = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(item.duration ?? 0);
  // The big player takes over from any row/card preview, and closing the
  // lightbox stops it — a detached media element can keep playing otherwise.
  // The element renders with the body, so it exists by the time this runs.
  useEffect(() => {
    usePreviewAudio.getState().stop();
    const el = audioEl.current;
    return () => el?.pause();
  }, []);
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 p-5 pt-10 shadow-2xl">
      <Music className="size-8 text-white/90" />
      {asset?.peaks && asset.peaks.length > 0 && (
        <PeakStrip peaks={asset.peaks} className="h-10 text-white/85" />
      )}
      <audio
        ref={audioEl}
        autoPlay
        src={item.src}
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(loadedDuration(e.currentTarget, item))}
        onEnded={() => setPlaying(false)}
      />
      <MediaTransport
        variant="inline"
        playing={playing}
        time={time}
        duration={duration}
        onToggle={() => {
          const el = audioEl.current;
          if (!el) return;
          if (el.paused) void el.play();
          else el.pause();
        }}
        onSeek={(t) => {
          const el = audioEl.current;
          if (!el) return;
          el.currentTime = t;
          setTime(t);
        }}
      />
    </div>
  );
}

/** A font, big: the sheet a font file previews on, the alphabet filling it. */
function FontBody({ item }: { item: LightboxItem }) {
  return (
    // The sheet keeps its margin whichever way the alphabet arrives: the baked
    // picture is the same charcoal, so padding it reads as more sheet.
    <div
      className="overflow-hidden rounded-2xl px-10 py-12 shadow-2xl"
      style={{ backgroundColor: SPECIMEN_BG, color: SPECIMEN_INK }}
    >
      <FontSpecimen
        assetId={item.libraryId ?? ""}
        poster={item.poster}
        lines={SPECIMEN_ALPHABET}
        pad={0}
        className="w-full"
      />
    </div>
  );
}

function TextBody({ item }: { item: LightboxItem }) {
  const { text, failed } = useDocText(item.src);
  return (
    <div className="flex max-h-[68vh] flex-col overflow-hidden rounded-2xl bg-card shadow-2xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5 pr-12">
        <FileText className="size-4 text-muted-foreground" />
        <span className="truncate text-[12.5px] font-medium">{item.name}</span>
      </div>
      <div className="min-h-0 overflow-y-auto px-4 py-3 text-[12.5px] leading-relaxed">
        {failed ? (
          <p className="text-muted-foreground">Could not read the file.</p>
        ) : text === null ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <DocText name={item.name} text={text} />
        )}
      </div>
    </div>
  );
}
