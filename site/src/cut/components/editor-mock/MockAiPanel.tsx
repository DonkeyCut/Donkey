"use client";

import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleDashed,
  History,
  Mic,
  Plus,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  MockChatMessage,
  MockProject,
} from "@/cut/components/editor-mock/mockData";

/** Static replica of the Cut editor's AI chat panel for the landing mock.
 * Mirrors AiPanel's structure and Tailwind styling with hardcoded content. */
export function MockAiPanel({ project }: { project: MockProject }) {
  return (
    <aside className="relative flex h-full w-[340px] shrink-0 flex-col overflow-hidden border-l border-border bg-card">
      <div className="flex h-[46px] shrink-0 items-center gap-1.5 border-b border-border pr-2 pl-3.5">
        <div className="flex-1" />
        <span className="grid size-8 place-items-center rounded-md text-muted-foreground">
          <History className="size-4" />
        </span>
        <span className="grid size-8 place-items-center rounded-md text-muted-foreground">
          <Plus className="size-4" />
        </span>
        <span className="grid size-8 place-items-center rounded-md text-muted-foreground">
          <X className="size-4" />
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-3.5 py-3">
        {project.chat.map((message, index) => (
          <MockMessage key={index} message={message} index={index} />
        ))}
        <div
          className="mock-chat-msg mt-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground"
          style={{ animationDelay: `${project.chat.length * 120}ms` }}
        >
          <CircleDashed className="size-3 animate-spin" /> Working… 3s
        </div>
      </div>

      <div className="shrink-0 px-2.5 pb-2.5">
        {/* The real composer is bg-background, which the editor's app-surface
            paints white; on the cream landing that token stays cream, so the
            mock pins white directly. */}
        <div className="rounded-xl border border-input bg-white">
          <div className="min-h-9 px-3 pt-2 text-[12.5px] leading-relaxed text-muted-foreground/70">
            Ask about your video, or tell me what to change… @ references media
          </div>
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            <span className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground">
              <Sparkles className="size-3" />
              Fable 5
              <ChevronDown className="size-3" />
            </span>
            <div className="flex-1" />
            <span className="grid h-8 place-items-center rounded-md px-2.5 text-muted-foreground">
              <Mic className="size-3.5" />
            </span>
            <span className="grid h-8 place-items-center rounded-md bg-primary px-3 text-primary-foreground shadow-xs">
              <ArrowUp className="size-3.5" />
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function MockMessage({
  message,
  index,
}: {
  message: MockChatMessage;
  index: number;
}) {
  const delay = { animationDelay: `${index * 120}ms` };
  if (message.role === "user") {
    return (
      <div
        className="mock-chat-msg mb-3 flex flex-col items-end gap-1"
        style={delay}
      >
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-neutral-900 px-3 py-2 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-white">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="mock-chat-msg mb-3 flex flex-col gap-1.5" style={delay}>
      {message.tool && (
        <span className="flex w-fit max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
          <Wrench className="size-3 shrink-0" />
          <span className="font-mono">{message.tool.name}</span>
          {message.tool.count && (
            <span className="text-[10px] tabular-nums">×{message.tool.count}</span>
          )}
          <Check className="size-3 text-emerald-600" />
        </span>
      )}
      <div className="max-w-full text-[12.5px] leading-relaxed whitespace-pre-line">
        {message.text}
      </div>
      {message.cards && (
        <div
          className={cn(
            "grid gap-1.5",
            // Tall cards leave no room for a third column.
            message.portrait || message.cards.length <= 2
              ? "grid-cols-2"
              : "grid-cols-3",
          )}
        >
          {message.cards.map((card) => (
            <div key={card.src} className="flex flex-col gap-1">
              <div
                className={cn(
                  "relative overflow-hidden rounded-md border border-border",
                  message.portrait
                    ? "aspect-[9/16]"
                    : card.duration
                      ? "aspect-video"
                      : "aspect-[3/4]",
                )}
              >
                <img
                  src={card.src}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                />
                {card.duration && (
                  <span className="absolute right-1 bottom-1 rounded bg-black/65 px-1 font-mono text-[10px] text-white">
                    {card.duration}
                  </span>
                )}
              </div>
              {card.label && (
                <span className="w-full truncate text-[10px] text-muted-foreground">
                  {card.label}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
