"use client";

import {
  Captions,
  ChevronDown,
  Clapperboard,
  ClipboardList,
  Film,
  Image as ImageIcon,
  Layers,
  Music,
  Play,
  Sparkles,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  MockMediaItem,
  MockPanel,
  MockPanelTab,
  MockProject,
  MockTemplate,
} from "@/cut/components/editor-mock/mockData";

// Static replica of the editor's left side panel for the landing mock: the
// icon rail plus whichever panel the slide has open, populated from hardcoded
// slide data. Class strings mirror SidePanel/ImageGenPanel/GeneratePanel so it
// is indistinguishable from the real editor at a glance.

const TABS: { id: MockPanelTab; label: string; icon: typeof Film }[] = [
  { id: "media", label: "Media", icon: Clapperboard },
  { id: "video", label: "Video", icon: Film },
  { id: "image", label: "Image", icon: ImageIcon },
  { id: "audio", label: "Audio", icon: Music },
  { id: "subtitles", label: "Subtitles", icon: Captions },
  { id: "details", label: "Details", icon: ClipboardList },
];

/** The rounded pill-select chrome, closed. */
function Pill({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "relative flex items-center rounded-full border border-input py-1.5 pr-2.5 pl-3.5",
        className
      )}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{label}</span>
      <ChevronDown className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
    </span>
  );
}

export function MockSidePanel({ project }: { project: MockProject }) {
  const { panel } = project;

  return (
    <div className="flex h-full min-h-0 overflow-hidden border-r border-border bg-card">
      {/* Icon rail */}
      <div className="flex min-h-0 w-[68px] shrink-0 flex-col items-center gap-1 overflow-hidden border-r border-border py-3">
        {TABS.map(({ id, label, icon: Icon }) => [
          // Soft breaks between the file tabs, the AI-generate tabs, and the finishing tabs.
          id === "video" || id === "subtitles" ? (
            <div key={`${id}-break`} aria-hidden className="my-1 h-px w-8 shrink-0 bg-border" />
          ) : null,
          <div
            key={id}
            className="flex shrink-0 flex-col items-center gap-1 rounded-lg px-2 py-1.5 text-muted-foreground"
          >
            <span
              className={cn(
                "relative grid size-9 place-items-center rounded-lg",
                panel.tab === id && "bg-muted text-foreground"
              )}
            >
              <Icon className="size-4.5" />
            </span>
            <span
              className={cn(
                "text-[10px] font-medium",
                panel.tab === id && "text-foreground"
              )}
            >
              {label}
            </span>
          </div>,
        ])}
      </div>

      <div className="flex w-[252px] min-h-0 shrink-0 flex-col">
        {panel.tab === "media" ? (
          <MediaPanel panel={panel} />
        ) : (
          <GeneratePanel panel={panel} aspect={project.aspect} />
        )}
      </div>
    </div>
  );
}

/** The project's own files: what the user uploaded or recorded, plus the
 * arrangements they saved. Generated media lives where it was made, so it
 * never shows up here. */
function MediaPanel({ panel }: { panel: Extract<MockPanel, { tab: "media" }> }) {
  return (
    <>
      <div className="flex h-12 shrink-0 items-center px-3.5">
        <div className="flex w-full rounded-lg bg-muted p-0.5 text-[11.5px]">
          <span className="flex-1 rounded-md bg-background px-3 py-0.5 text-center font-medium text-foreground shadow-sm">
            Project Files
          </span>
          <span className="flex-1 rounded-md px-3 py-0.5 text-center font-medium text-muted-foreground">
            Library
          </span>
        </div>
      </div>
      <div className="shrink-0 px-3.5 pb-3">
        <span className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-input text-sm font-medium">
          <Upload className="size-4" /> Upload
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-3.5 pb-4">
        <div className="flex shrink-0 flex-col gap-1.5">
          {panel.templates.map((t, i) => (
            <TemplateRow key={i} template={t} />
          ))}
        </div>
        <div className="grid shrink-0 grid-cols-2 content-start gap-2.5">
          {panel.items.map((item) => (
            <MediaCard key={item.handle} item={item} />
          ))}
        </div>
      </div>
    </>
  );
}

function TemplateRow({ template }: { template: MockTemplate }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5">
      <Layers className="size-3.5 shrink-0 text-violet-500" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium">{template.name}</div>
        <div className="flex items-center gap-0.5 text-[10.5px] text-muted-foreground">
          {template.duration} · {template.items} items
          <ChevronDown className="size-3" />
        </div>
      </div>
    </div>
  );
}

function MediaCard({ item }: { item: MockMediaItem }) {
  return (
    <div className="flex flex-col gap-1.5 text-left">
      <div className="relative aspect-square overflow-hidden rounded-lg border border-border bg-muted">
        {item.kind === "audio" ? (
          <AudioFace item={item} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- static landing asset
          <img src={item.thumb} alt="" className="size-full object-cover" />
        )}
        {item.kind === "video" && item.duration && (
          <span className="absolute right-1 bottom-1 rounded-[5px] bg-black/65 px-1 py-px font-mono text-[9.5px] tabular-nums text-white">
            {item.duration}
          </span>
        )}
      </div>
      {item.kind !== "audio" && (
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Handle handle={item.handle} />
          <span className="truncate">{item.name}</span>
        </span>
      )}
    </div>
  );
}

/** Audio has no frame to show, so the card is the waveform itself — the same
 * green face, play button, and duration pill the editor draws. */
function AudioFace({ item }: { item: MockMediaItem }) {
  return (
    <div className="relative size-full bg-[#0F6E56]">
      <div className="absolute inset-x-[8%] top-1/2 flex h-[36%] -translate-y-1/2 items-center justify-between">
        {Array.from({ length: 34 }, (_, i) => (
          <span
            key={i}
            className="w-[2px] rounded-full bg-[#8fd8bb]"
            style={{ height: `${AUDIO_PEAKS[i % AUDIO_PEAKS.length]}%` }}
          />
        ))}
      </div>
      <span className="absolute bottom-2 left-2 grid size-8 place-items-center rounded-full bg-[#e3f2e8] text-[#0F6E56] shadow">
        <Play className="size-3.5 translate-x-px" />
      </span>
      <span className="absolute top-1.5 left-1.5 flex max-w-[70%] min-w-0 items-center gap-1 px-2 py-1 text-[11px] font-medium text-white">
        <Handle handle={item.handle} dark />
        <span className="truncate">{item.name}</span>
      </span>
      {item.duration && (
        <span className="absolute right-2 bottom-3 rounded-md bg-[#2b4e42] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#d6eddf]">
          {item.duration}
        </span>
      )}
    </div>
  );
}

/** The short reference a prompt can name the file by (`@v1`). */
function Handle({ handle, dark }: { handle: string; dark?: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-[5px] px-1 py-px font-mono text-[9px] font-medium",
        dark ? "bg-white/25 text-white" : "bg-[#0a84ff]/12 text-[#0a84ff]"
      )}
    >
      {handle}
    </span>
  );
}

/** Deterministic waveform silhouette for the audio card face. */
const AUDIO_PEAKS = [
  46, 78, 34, 92, 58, 70, 40, 86, 52, 64, 96, 30, 74, 44, 82, 56, 68, 38, 90, 50,
];

function GeneratePanel({
  panel,
  aspect,
}: {
  panel: Extract<MockPanel, { tab: "image" | "video" }>;
  aspect: MockProject["aspect"];
}) {
  const isImage = panel.tab === "image";

  return (
    <>
      <div className="flex h-12 shrink-0 items-center pr-2.5 pl-4">
        <span className="text-sm font-semibold tracking-tight">
          {isImage ? "Generate image" : "Generate video"}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-3.5 pb-4">
        {/* Composer, filled with the slide's prompt */}
        <div className="relative flex shrink-0 flex-col rounded-lg border border-input">
          <div className="min-h-[88px] w-full px-2.5 py-2 pr-9 text-[12.5px] leading-relaxed">
            {panel.prompt}
          </div>
        </div>

        {isImage ? (
          <div className="flex shrink-0 items-center gap-2">
            <Pill
              className="min-w-0 flex-1"
              label={aspect === "9:16" ? "Vertical" : "Widescreen"}
            />
            <Pill label="2K" />
          </div>
        ) : (
          <>
            <Pill className="h-7 shrink-0" label="Omni Flash" />
            <Pill
              className="h-7 shrink-0"
              label={aspect === "9:16" ? "Vertical" : "Widescreen"}
            />
          </>
        )}

        <div className="flex h-8 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-primary pr-2.5 pl-2 text-sm font-medium whitespace-nowrap text-primary-foreground">
          <Sparkles className="size-4 shrink-0" />
          {isImage ? "Generate image" : "Generate video"}
        </div>

        {!isImage && (
          <p className="shrink-0 text-[11px] leading-relaxed text-muted-foreground">
            Renders take a minute or two. Keep editing while it runs.
          </p>
        )}

        {isImage && <div className="text-xs font-semibold text-muted-foreground">Generated</div>}

        {isImage ? (
          <div className="grid shrink-0 grid-cols-2 content-start gap-2.5">
            {panel.results.map((r) => (
              <div key={r.src} className="flex flex-col gap-1.5">
                <div
                  className={cn(
                    "relative aspect-[3/4] overflow-hidden rounded-lg border border-border bg-muted",
                    r.selected && "ring-2 ring-[#0a84ff]"
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- static landing asset */}
                  <img src={r.src} alt="" className="size-full object-cover" />
                </div>
                <span className="truncate text-[11px] text-muted-foreground">{r.label}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid shrink-0 grid-cols-2 content-start gap-2.5">
            {panel.results.map((r) => (
              <div
                key={r.src}
                className={cn(
                  "relative aspect-video overflow-hidden rounded-lg border border-border bg-muted",
                  r.selected && "ring-2 ring-[#0a84ff]"
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- static landing asset */}
                <img src={r.src} alt="" className="size-full object-cover" />
                {r.duration && (
                  <span className="absolute right-1 bottom-1 rounded bg-black/65 px-1 font-mono text-[10px] text-white">
                    {r.duration}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
