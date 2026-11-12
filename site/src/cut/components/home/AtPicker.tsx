"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AudioLines, FileText, Film, Folder, StickyNote } from "lucide-react";
import { CardPreview } from "@/cut/components/assets/ProjectCard";
import type { MentionMenu } from "@/cut/components/AssetRefs";
import { useInView } from "@/cut/hooks/useInView";
import {
  libraryMediaUrl,
  libraryPosterUrl,
  type LibraryAsset,
} from "@/cut/lib/library";
import { MEDIA_CORS } from "@/cut/lib/mediaCors";
import { noteColor, NOTE_INK } from "@/cut/lib/notes";
import { backendFor } from "@/cut/lib/residency";
import { formatTime } from "@/cut/lib/time";
import type { ProjectSummary } from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import {
  filterAtRows,
  rowKind,
  tabsWithRows,
  type AtPreview,
  type AtRow,
  type AtTab,
} from "./atRows";

/** The picker's width; the composer keeps it inside its own edges. */
export const AT_MENU_WIDTH = 420;

// How long an audio row plays when it is active, in seconds.
const AUDIO_PREVIEW_S = 6;

// Where a video thumbnail's still is taken, in seconds.
const STILL_T = 0.1;

const ICONS = { folder: Folder, note: StickyNote, file: FileText } as const;

/**
 * The `@` picker: tabs by kind over a list that shows recent things before
 * anything is typed and narrows as the person types. The active row — under
 * the pointer, or reached with the arrow keys — plays inside its own
 * thumbnail; nothing opens beside the list.
 */
export function AtPicker({ menu, rows }: { menu: MentionMenu; rows: AtRow[] }) {
  const t = useTranslations("home.start.at");
  // A type with nothing in it gets no tab; a tab whose rows are gone falls
  // back to All.
  const tabs = tabsWithRows(rows);
  const [picked, setTab] = useState<AtTab>("all");
  const tab = tabs.includes(picked) ? picked : "all";
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = filterAtRows(rows, tab, menu.query);
  const index = Math.min(active, Math.max(0, shown.length - 1));

  // A new query or tab starts at the top of the list.
  const [seenQuery, setSeenQuery] = useState(menu.query);
  if (seenQuery !== menu.query) {
    setSeenQuery(menu.query);
    setActive(0);
  }

  // The composer hands over the arrow keys and Enter while the picker is up.
  // Read through a ref so the handler never holds a stale list.
  const state = useRef({ shown, index, pick: menu.pick });
  useEffect(() => {
    state.current = { shown, index, pick: menu.pick };
  });
  const bindKeys = menu.bindKeys;
  useEffect(() => {
    bindKeys((key) => {
      const { shown: list, index: at, pick } = state.current;
      if (list.length === 0) {
        return false;
      }
      if (key === "pick") {
        pick(list[at].ref);
        return true;
      }
      const next = (at + (key === "down" ? 1 : list.length - 1)) % list.length;
      setActive(next);
      listRef.current
        ?.querySelector(`[data-row="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
      return true;
    });
    return () => bindKeys(null);
  }, [bindKeys]);

  return (
    <div
      className="flex flex-col gap-0.5 rounded-2xl border border-border bg-popover p-2 text-popover-foreground shadow-[0_16px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
      style={{ width: AT_MENU_WIDTH, maxWidth: "calc(100vw - 2rem)" }}
    >
      <div
        role="tablist"
        aria-label={t("label")}
        className="mb-1 flex flex-wrap gap-1 border-b border-border px-1 pt-1 pb-2"
      >
        {tabs.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            // Keep the caret, and with it the mention, in the composer.
            onMouseDown={(e) => {
              e.preventDefault();
              setTab(key);
              setActive(0);
            }}
            className={cn(
              "h-7 rounded-full px-2.5 text-xs transition-colors",
              tab === key
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>

      {!menu.query.trim() && shown.length > 0 && (
        <span className="px-2.5 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
          {t("recent")}
        </span>
      )}

      <div
        ref={listRef}
        role="listbox"
        className="flex max-h-72 flex-col gap-0.5 overflow-y-auto"
      >
        {shown.length === 0 ? (
          <p className="px-2.5 py-3 text-[13px] text-muted-foreground">
            {t("noMatches")}
          </p>
        ) : (
          shown.map((row, i) => (
            <button
              key={`${row.ref.scope}:${row.ref.id}`}
              type="button"
              role="option"
              aria-selected={i === index}
              data-row={i}
              // Only a real pointer move picks a row: arrow keys scroll the
              // list under a resting pointer, and that must not steal the
              // highlight.
              onMouseMove={() => {
                if (i !== index) {
                  setActive(i);
                }
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                menu.pick(row.ref);
              }}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                i === index && "bg-muted",
              )}
            >
              <AtThumb preview={row.preview} active={i === index} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{row.label}</span>
                {row.items !== undefined ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {t("items", { count: row.items })}
                  </span>
                ) : (
                  rowKind(row) && (
                    <span className="truncate text-xs text-muted-foreground">
                      {t(`kinds.${rowKind(row)!}`)}
                    </span>
                  )
                )}
              </span>
              {!!row.ref.duration && (
                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                  {formatTime(row.ref.duration)}
                </span>
              )}
            </button>
          ))
        )}
      </div>

      <div className="mt-1 flex flex-wrap gap-3.5 border-t border-border px-2.5 pt-2 pb-0.5 text-xs text-muted-foreground">
        <span>{t("filterHint")}</span>
        <span>{t("attachHint")}</span>
      </div>
    </div>
  );
}

/** A row's 36px thumbnail. Media rows show a still and, while active, play
 * inside it; folders, notes and other files show a plain icon. */
export function AtThumb({
  preview,
  active,
  className,
}: {
  preview: AtPreview;
  active: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-[7px] border border-border bg-muted text-muted-foreground",
        className,
      )}
    >
      <ThumbBody preview={preview} active={active} />
    </span>
  );
}

function ThumbBody({
  preview,
  active,
}: {
  preview: AtPreview;
  active: boolean;
}) {
  if (preview.kind === "icon") {
    const Icon = ICONS[preview.icon];
    return <Icon className="size-4" />;
  }
  if (preview.kind === "note") {
    // The note's own paper, too small for its words.
    return (
      <span
        className="absolute inset-0 grid place-items-center"
        style={{
          backgroundColor: noteColor(preview.colorIndex).background,
          color: NOTE_INK,
        }}
      >
        <StickyNote className="size-4 opacity-70" />
      </span>
    );
  }
  if (preview.kind === "file") {
    return <FileText className="size-4" />;
  }
  if (preview.kind === "template") {
    // eslint-disable-next-line @next/next/no-img-element -- a signed CDN still, not a Next asset
    return (
      <img
        src={preview.poster}
        alt=""
        loading="lazy"
        className="absolute inset-0 size-full object-cover"
      />
    );
  }
  if (preview.kind === "templateMedia" && preview.media === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- a library file, not a Next asset
    return (
      <img
        crossOrigin={MEDIA_CORS}
        src={preview.src}
        alt=""
        loading="lazy"
        className="absolute inset-0 size-full object-cover"
      />
    );
  }
  if (preview.kind === "templateMedia") {
    return (
      <video
        crossOrigin={MEDIA_CORS}
        src={`${preview.src}#t=${STILL_T}`}
        muted
        playsInline
        preload="metadata"
        className="absolute inset-0 size-full object-cover"
      />
    );
  }
  if (preview.kind === "project") {
    return (
      <ProjectThumb
        project={preview.project}
        residency={preview.residency}
        active={active}
      />
    );
  }
  return <LibraryThumb asset={preview.asset} active={active} />;
}

/** A Library file's thumbnail: a picture as itself, a clip as its cover or
 * first frame, a sound as a waveform glyph. */
function LibraryThumb({
  asset: a,
  active,
}: {
  asset: LibraryAsset;
  active: boolean;
}) {
  const [ref, seen] = useInView<HTMLSpanElement>();
  const src = libraryMediaUrl(a.proxyFile ?? a.fileName, a.residency);
  const poster = libraryPosterUrl(a);

  if (a.type === "image") {
    return (
      <span ref={ref} className="absolute inset-0">
        {seen && (
          // eslint-disable-next-line @next/next/no-img-element -- a shelf file, not a Next asset
          <img
            crossOrigin={MEDIA_CORS}
            src={src}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        )}
      </span>
    );
  }
  if (a.type === "audio") {
    return (
      <>
        <AudioLines className="size-4" />
        {active && <PlayingAudio src={src} />}
      </>
    );
  }
  return (
    <span ref={ref} className="absolute inset-0">
      {poster ? (
        // eslint-disable-next-line @next/next/no-img-element -- a shelf file, not a Next asset
        <img
          crossOrigin={MEDIA_CORS}
          src={poster}
          alt=""
          loading="lazy"
          className="size-full object-cover"
        />
      ) : (
        seen && (
          <video
            crossOrigin={MEDIA_CORS}
            src={`${src}#t=${STILL_T}`}
            preload="metadata"
            muted
            playsInline
            className="size-full object-cover"
          />
        )
      )}
      {active && <PlayingVideo src={src} />}
    </span>
  );
}

/** A project's thumbnail: its card picture, and its rendered edit playing
 * while the row is active. */
function ProjectThumb({
  project: p,
  residency,
  active,
}: {
  project: ProjectSummary;
  residency: Parameters<typeof backendFor>[0];
  active: boolean;
}) {
  // A project with nothing to show yet reads as a film, sized like the
  // other rows' icons.
  if (!p.previewFile && !p.hasPreview) {
    return <Film className="size-4" />;
  }
  return (
    <>
      <CardPreview project={p} residency={residency} />
      {active && p.hasPreview && (
        <PlayingVideo
          src={backendFor(residency).url(`/api/cut/projects/${p.id}/preview`)}
        />
      )}
    </>
  );
}

/** A clip playing muted over a thumbnail's still, with a thin bar for how far
 * along it is. It stays clear until its first frame plays, so the still holds
 * the picture meanwhile. Mounted only while its row is active, so leaving the
 * row releases it and the still is already there. */
function PlayingVideo({ src }: { src: string }) {
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  return (
    <>
      <video
        crossOrigin={MEDIA_CORS}
        src={src}
        autoPlay
        muted
        loop
        playsInline
        onTimeUpdate={(e) =>
          setAt(
            e.currentTarget.duration
              ? e.currentTarget.currentTime / e.currentTarget.duration
              : 0,
          )
        }
        onPlaying={() => setPlaying(true)}
        className={cn("absolute inset-0 size-full object-cover", !playing && "opacity-0")}
      />
      {playing && <ProgressBar at={at} tone="media" />}
    </>
  );
}

/** A short stretch of a sound, heard while its row is active. */
function PlayingAudio({ src }: { src: string }) {
  const [at, setAt] = useState(0);
  return (
    <>
      <audio
        crossOrigin={MEDIA_CORS}
        src={src}
        autoPlay
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (el.currentTime >= AUDIO_PREVIEW_S) {
            el.pause();
          }
          setAt(
            Math.min(
              1,
              el.currentTime /
                Math.min(AUDIO_PREVIEW_S, el.duration || AUDIO_PREVIEW_S),
            ),
          );
        }}
      />
      <ProgressBar at={at} tone="surface" />
    </>
  );
}

/** How far a preview has played: white over a picture, the text color over
 * the thumbnail's own surface. */
function ProgressBar({ at, tone }: { at: number; tone: "media" | "surface" }) {
  return (
    <span
      className={cn(
        "absolute inset-x-1 bottom-1 h-[3px] overflow-hidden rounded-full",
        tone === "media" ? "bg-white/45" : "bg-foreground/20",
      )}
    >
      <span
        className={cn(
          "block h-full rounded-full",
          tone === "media" ? "bg-white" : "bg-foreground",
        )}
        style={{ width: `${Math.round(at * 100)}%` }}
      />
    </span>
  );
}
