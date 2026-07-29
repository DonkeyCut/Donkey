"use client";

import {
  Check,
  ChevronDown,
  ChevronLeft,
  Monitor,
  Smartphone,
  Sparkles,
  Upload,
} from "lucide-react";

import type { MockProject } from "@/cut/components/editor-mock/mockData";
import { aspectLabel } from "@/cut/lib/types";

// Static replica of src/cut/components/TopBar.tsx — same chrome, no store.
export function MockTopBar({ project }: { project: MockProject }) {
  const AspectIcon = project.aspect === "9:16" ? Smartphone : Monitor;
  return (
    <header className="relative flex items-center justify-between border-b border-border bg-card pr-3 pl-2">
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-xs">
          <AspectIcon className="size-3.5" />
          {aspectLabel(project.aspect)}
          <ChevronDown className="size-3" />
        </span>
        <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-xs">
          <span className="size-2 rounded-full bg-red-500" aria-hidden />
          Record
          <ChevronDown className="size-3" />
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        <span className="grid size-7 place-items-center rounded-md text-muted-foreground">
          <ChevronLeft className="size-4" />
        </span>
        <span className="grid size-[22px] shrink-0 place-items-center">
          <img
            src="/donkey-logo.svg"
            alt=""
            width={22}
            height={22}
            className="block h-full w-full object-contain"
          />
        </span>
        <span className="ml-1.5 max-w-64 truncate rounded-md px-2 py-1 text-sm font-medium tracking-tight">
          {project.name}
        </span>
        <span className="ml-2 flex items-center gap-1 text-[11px] text-muted-foreground opacity-60">
          <Check className="size-3" /> Saved
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-foreground">
          <Sparkles className="size-3.5" /> Chat
        </span>
        <span className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs">
          <Upload className="size-3.5" /> Export
        </span>
      </div>
    </header>
  );
}
