"use client";

import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** The field a card's name turns into for a rename. Enter or leaving the
 * field keeps the new name, Escape keeps the old one; `onDone` gets the name
 * only when it changed. Keys and clicks stay in the field, so typing never
 * reaches the editor's shortcuts and clicking never picks or opens the card. */
export function RenameInput({
  value,
  onDone,
  className,
}: {
  value: string;
  onDone: (name?: string) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = draft.trim();
    onDone(keep && next && next !== value ? next : undefined);
  };
  return (
    <Input
      autoFocus
      value={draft}
      aria-label="Name"
      className={cn("h-6 w-full px-1.5 text-[12px]", className)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
