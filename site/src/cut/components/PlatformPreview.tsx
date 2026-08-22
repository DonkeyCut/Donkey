"use client";

import { useEffect, useRef, useState } from "react";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { apiUrl } from "@/cut/lib/backend";
import {
  Bookmark,
  Camera,
  Heart,
  MessageCircle,
  MoreHorizontal,
  Music2,
  Search,
  Send,
  Share2,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { normalizeTags } from "@/cut/lib/publish";
import { useEditor } from "@/cut/lib/store";
import { MediaTransport } from "@/cut/components/MediaTransport";
import { parseRatio } from "@/cut/lib/types";
import { cn } from "@/lib/utils";

export interface ExportItem {
  file: string;
  size: number;
  mtime: number;
}

type Platform = "original" | "tiktok" | "instagram" | "youtube";

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "original", label: "Original" },
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
  { id: "youtube", label: "YouTube" },
];

const shadow = "[text-shadow:0_1px_3px_rgba(0,0,0,0.6)]";

/** Full post preview: the export playing inside a phone, dressed in each
 * platform's overlay chrome, with the publish metadata (edited in the Details
 * tab) rendered in place. "Original" drops the phone and plays the export at
 * its own frame size. */
export function PlatformPreviewDialog({
  projectId,
  item,
  onClose,
}: {
  projectId: string;
  item: ExportItem;
  onClose: () => void;
}) {
  const publish = useEditor((s) => s.publish);
  const aspect = useEditor((s) => s.aspect);
  const [platform, setPlatform] = useState<Platform>("original");
  const [muted, setMuted] = useState(true);
  // Shape the stage before a single byte of video arrives: the project already
  // knows the frame it exported, so the dialog opens at its final size and the
  // file's own dimensions only ever confirm it.
  const [ratio, setRatio] = useState(() => {
    const r = parseRatio(aspect) ?? { w: 9, h: 16 };
    return r.w / r.h;
  });
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  const url = apiUrl(`/api/cut/projects/${projectId}/exports/${encodeURIComponent(item.file)}`);
  const handle = publish.handle.trim().replace(/^@+/, "") || "you";
  const caption = publish.caption.trim();
  const tagsLine = normalizeTags(publish.tags);
  const sound = publish.soundTitle.trim() || `original sound - ${handle}`;
  const original = platform === "original";

  return (
    <div
      data-slot="dialog-content"
      className="platform-preview fixed inset-0 z-70 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex max-h-full flex-col items-center gap-4 overflow-hidden rounded-2xl bg-card px-10 py-5 shadow-2xl">
        <button
          className="absolute top-3 right-3 grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Close preview"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>

        <div className="flex gap-1 rounded-full border border-border bg-card p-1 shadow-xs">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              className={cn(
                "rounded-full px-3.5 py-1 text-xs font-medium transition-colors",
                platform === p.id
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-pressed={platform === p.id}
              onClick={() => setPlatform(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* The stage: Original sizes itself to the export's own frame; the
            platform mocks put it inside a fixed 9:16 phone. */}
        <div
          className={cn(
            "group relative overflow-hidden bg-black",
            original
              ? "rounded-xl shadow-[0_24px_60px_rgba(0,0,0,0.35)]"
              : "phone h-[600px] w-[290px] rounded-[38px] border-[9px] border-neutral-950 shadow-[0_24px_60px_rgba(0,0,0,0.45)]"
          )}
          style={
            original
              ? { width: `min(80vw, ${(78 * ratio).toFixed(3)}vh)`, aspectRatio: String(ratio) }
              : undefined
          }
        >
          <video
            ref={videoRef}
            crossOrigin={MEDIA_CORS}
            src={url}
            className="absolute inset-0 size-full object-cover"
            autoPlay
            loop
            muted={muted}
            playsInline
            onClick={togglePlay}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              setDuration(v.duration || 0);
              if (v.videoWidth && v.videoHeight) {
                const r = v.videoWidth / v.videoHeight;
                setRatio((prev) => (Math.abs(prev - r) > 0.005 ? r : prev));
              }
            }}
          />
          {/* legibility gradients — only under platform chrome */}
          {!original && (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-black/50 to-transparent" />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-44 bg-gradient-to-t from-black/70 via-black/25 to-transparent" />
            </>
          )}

          <button
            className="absolute top-3.5 left-3.5 z-20 grid size-7 place-items-center rounded-full bg-black/40 text-white"
            aria-label={muted ? "Unmute" : "Mute"}
            onClick={() => setMuted((m) => !m)}
          >
            {muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
          </button>

          {original && (
            <MediaTransport
              playing={playing}
              time={time}
              duration={duration}
              onToggle={togglePlay}
              onSeek={(t) => {
                const v = videoRef.current;
                if (!v) return;
                v.currentTime = t;
                setTime(t);
              }}
            />
          )}

          {platform === "tiktok" && (
            <TikTokChrome handle={handle} caption={caption} tags={tagsLine} sound={sound} />
          )}
          {platform === "instagram" && (
            <ReelsChrome handle={handle} caption={caption} tags={tagsLine} sound={sound} />
          )}
          {platform === "youtube" && (
            <ShortsChrome handle={handle} caption={caption} tags={tagsLine} sound={sound} />
          )}
        </div>
      </div>
    </div>
  );
}

interface ChromeProps {
  handle: string;
  caption: string;
  tags: string;
  sound: string;
}

function Avatar({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "block rounded-full bg-gradient-to-br from-[#3d9bff] to-[#0a5fd4] ring-2 ring-white",
        className
      )}
    />
  );
}

function RailItem({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      {icon}
      {label && (
        <span className={cn("text-[10px] font-semibold text-white", shadow)}>{label}</span>
      )}
    </div>
  );
}

function TikTokChrome({ handle, caption, tags, sound }: ChromeProps) {
  return (
    <div className="preview-tiktok pointer-events-none absolute inset-0 z-10">
      <div
        className={cn(
          "absolute top-4 inset-x-0 flex items-center justify-center gap-4 text-[13px] text-white",
          shadow
        )}
      >
        <span className="opacity-75">Following</span>
        <span className="relative font-semibold">
          For You
          <span className="absolute -bottom-1.5 left-1/2 h-0.5 w-5 -translate-x-1/2 rounded bg-white" />
        </span>
        <Search className="absolute right-4 size-4.5 text-white" />
      </div>

      <div className="absolute right-2.5 bottom-20 flex flex-col items-center gap-3.5">
        <div className="relative">
          <Avatar className="size-10" />
          <span className="absolute -bottom-1.5 left-1/2 grid size-4 -translate-x-1/2 place-items-center rounded-full bg-[#fe2c55] text-[10px] font-bold text-white">
            +
          </span>
        </div>
        <RailItem icon={<Heart className="size-7 fill-white text-white" />} label="328.7K" />
        <RailItem
          icon={<MessageCircle className="size-7 fill-white text-white" />}
          label="1,842"
        />
        <RailItem icon={<Bookmark className="size-6.5 fill-white text-white" />} label="12.3K" />
        <RailItem icon={<Share2 className="size-6.5 fill-white text-white" />} label="Share" />
        <span className="mt-0.5 grid size-9 animate-[spin_5s_linear_infinite] place-items-center rounded-full bg-neutral-900 ring-4 ring-neutral-800">
          <Music2 className="size-3.5 text-white" />
        </span>
      </div>

      <div className="absolute bottom-5 left-3 flex w-[72%] flex-col gap-1.5">
        <span className={cn("preview-handle text-[14px] font-semibold text-white", shadow)}>
          @{handle}
        </span>
        {(caption || tags) && (
          <p className={cn("preview-caption line-clamp-3 text-[12.5px] leading-snug text-white", shadow)}>
            {caption}
            {caption && tags ? " " : ""}
            {tags && <span className="font-semibold">{tags}</span>}
          </p>
        )}
        <div className={cn("flex items-center gap-1.5 text-[12px] text-white", shadow)}>
          <Music2 className="size-3.5 shrink-0" />
          <span className="preview-sound truncate">{sound}</span>
        </div>
      </div>
    </div>
  );
}

function ReelsChrome({ handle, caption, tags, sound }: ChromeProps) {
  return (
    <div className="preview-instagram pointer-events-none absolute inset-0 z-10">
      <div className="absolute top-4 inset-x-0 flex items-center justify-between px-4">
        <span className={cn("text-[17px] font-semibold text-white", shadow)}>Reels</span>
        <Camera className="size-5 text-white" />
      </div>

      <div className="absolute right-2.5 bottom-16 flex flex-col items-center gap-4">
        <RailItem icon={<Heart className="size-6.5 text-white" />} label="44.2K" />
        <RailItem icon={<MessageCircle className="size-6.5 -scale-x-100 text-white" />} label="512" />
        <RailItem icon={<Send className="size-6 text-white" />} />
        <RailItem icon={<Bookmark className="size-6 text-white" />} />
        <RailItem icon={<MoreHorizontal className="size-5.5 text-white" />} />
        <span className="grid size-6.5 place-items-center rounded-md border-2 border-white/85 bg-gradient-to-br from-fuchsia-500 to-amber-400">
          <Music2 className="size-3 text-white" />
        </span>
      </div>

      <div className="absolute bottom-4 left-3 flex w-[74%] flex-col gap-2">
        <div className="flex items-center gap-2">
          <Avatar className="size-7.5 ring-1" />
          <span className={cn("preview-handle text-[13px] font-semibold text-white", shadow)}>
            {handle}
          </span>
          <span className="rounded-md border border-white/80 px-1.5 py-0.5 text-[11px] font-medium text-white">
            Follow
          </span>
        </div>
        {(caption || tags) && (
          <p className={cn("preview-caption line-clamp-2 text-[12px] leading-snug text-white", shadow)}>
            {caption}
            {caption && tags ? " " : ""}
            {tags}
            <span className="text-white/60"> … more</span>
          </p>
        )}
        <div className="flex max-w-full items-center gap-1.5 self-start rounded-full border border-white/25 bg-black/35 px-2.5 py-1 backdrop-blur-sm">
          <Music2 className="size-3 shrink-0 text-white" />
          <span className={cn("preview-sound max-w-44 truncate text-[11px] text-white", shadow)}>
            {handle} · {sound}
          </span>
        </div>
      </div>
    </div>
  );
}

function ShortsChrome({ handle, caption, tags, sound }: ChromeProps) {
  return (
    <div className="preview-youtube pointer-events-none absolute inset-0 z-10">
      <div className="absolute top-4 inset-x-0 flex items-center justify-between px-4">
        <span className={cn("text-[17px] font-semibold text-white", shadow)}>Shorts</span>
        <div className="flex items-center gap-4">
          <Camera className="size-5 text-white" />
          <Search className="size-5 text-white" />
          <MoreHorizontal className="size-5 rotate-90 text-white" />
        </div>
      </div>

      <div className="absolute right-2.5 bottom-14 flex flex-col items-center gap-4">
        <RailItem icon={<ThumbsUp className="size-6 text-white" />} label="Like" />
        <RailItem icon={<ThumbsDown className="size-6 text-white" />} label="Dislike" />
        <RailItem icon={<MessageCircle className="size-6 -scale-x-100 text-white" />} label="1.2K" />
        <RailItem icon={<Share2 className="size-6 text-white" />} label="Share" />
        <span className="grid size-9 animate-[spin_6s_linear_infinite] place-items-center rounded-lg bg-neutral-900 ring-2 ring-white/20">
          <Music2 className="size-3.5 text-white" />
        </span>
      </div>

      <div className="absolute bottom-5 left-3 flex w-[74%] flex-col gap-2">
        <div className="flex items-center gap-2">
          <Avatar className="size-7.5 ring-1" />
          <span className={cn("preview-handle text-[13px] font-semibold text-white", shadow)}>
            @{handle}
          </span>
          <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-black">
            Subscribe
          </span>
        </div>
        {(caption || tags) && (
          <p className={cn("preview-caption line-clamp-2 text-[12.5px] leading-snug text-white", shadow)}>
            {caption}
            {caption && tags ? " " : ""}
            {tags}
          </p>
        )}
        <div className={cn("flex items-center gap-1.5 text-[11.5px] text-white", shadow)}>
          <Music2 className="size-3.5 shrink-0" />
          <span className="preview-sound truncate">{sound}</span>
        </div>
      </div>
    </div>
  );
}
