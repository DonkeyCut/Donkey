"use client";

import {
  Captions,
  ChevronDown,
  Clapperboard,
  ClipboardList,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Music,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  MockPanelTab,
  MockProject,
} from "@/cut/components/editor-mock/mockData";

// Static replica of the editor's left side panel for the landing mock: the
// icon rail plus the open generation panel, populated from hardcoded slide
// data. Class strings mirror SidePanel/ImageGenPanel/GeneratePanel so it is
// indistinguishable from the real editor at a glance.

const TABS: { id: MockPanelTab; label: string; icon: typeof Film }[] = [
  { id: "media", label: "Media", icon: Clapperboard },
  { id: "library", label: "Library", icon: FolderOpen },
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
  const isImage = project.panelTab === "image";

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
                project.panelTab === id && "bg-muted text-foreground"
              )}
            >
              <Icon className="size-4.5" />
            </span>
            <span
              className={cn(
                "text-[10px] font-medium",
                project.panelTab === id && "text-foreground"
              )}
            >
              {label}
            </span>
          </div>,
        ])}
      </div>

      {/* Open generation panel */}
      <div className="flex w-[252px] min-h-0 shrink-0 flex-col">
        <div className="flex h-12 shrink-0 items-center pr-2.5 pl-4">
          <span className="text-sm font-semibold tracking-tight">
            {isImage ? "Generate image" : "Generate video"}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-3.5 pb-4">
          {/* Composer, filled with the slide's prompt */}
          <div className="relative flex shrink-0 flex-col rounded-lg border border-input">
            <div className="min-h-[88px] w-full px-2.5 py-2 pr-9 text-[12.5px] leading-relaxed">
              {project.panelPrompt}
            </div>
          </div>

          {isImage ? (
            <div className="flex shrink-0 items-center gap-2">
              <Pill
                className="min-w-0 flex-1"
                label={project.aspect === "9:16" ? "Portrait" : "Landscape"}
              />
              <Pill label="2K" />
            </div>
          ) : (
            <>
              <Pill className="h-7 shrink-0" label="Omni Flash" />
              <Pill
                className="h-7 shrink-0"
                label={project.aspect === "9:16" ? "Portrait" : "Landscape"}
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
              {project.panelResults.map((r) => (
                <div key={r.label} className="flex flex-col gap-1.5">
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
              {project.panelResults.map((r) => (
                <div
                  key={r.label}
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
      </div>
    </div>
  );
}
