"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A panel that rises from the bottom of the screen.
 *
 * On a phone this is what the editor's side panels become. They are fixed-width
 * columns in a row of columns, which is a shape a narrow screen has no room
 * for; a sheet gives the same content the full width and leaves the video
 * visible above it.
 *
 * Height is capped rather than fixed so a short panel stays short, and the body
 * scrolls inside the sheet so the page behind it never does.
 */
export function BottomSheet({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[75dvh] flex-col rounded-t-2xl border-t border-border bg-card shadow-2xl"
      >
        {/* A grab handle reads as "this can be dismissed" on touch, where there
            is no cursor to hint it. */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="h-1 w-9 rounded-full bg-muted-foreground/30" />
        </div>
        <div className="flex items-center justify-between px-4 pb-2">
          <h2 className="text-sm font-medium">{title}</h2>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
    </div>
  );
}
